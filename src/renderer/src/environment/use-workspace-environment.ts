import { useEffect, useMemo, useState } from 'react'

import type { WorkspaceEnvironmentSnapshot } from '../../../shared/contracts'

export type WorkspaceEnvironmentViewState =
  | 'idle'
  | 'loading'
  | WorkspaceEnvironmentSnapshot['state']
  | 'error'

export interface WorkspaceEnvironmentView {
  readonly state: WorkspaceEnvironmentViewState
  readonly branch: string | null
  readonly additions: number
  readonly deletions: number
  readonly changedFiles: number
  readonly clean: boolean
  readonly message: string
}

interface UseWorkspaceEnvironmentOptions {
  readonly workspaceToken: string
  readonly enabled: boolean
}

const POLL_INTERVAL_MS = 3_000

const EMPTY_ENVIRONMENT: WorkspaceEnvironmentView = Object.freeze({
  state: 'idle',
  branch: null,
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  clean: true,
  message: '',
})

export function useWorkspaceEnvironment(
  options: UseWorkspaceEnvironmentOptions,
): WorkspaceEnvironmentView {
  const [record, setRecord] = useState<{
    readonly workspaceToken: string
    readonly view: WorkspaceEnvironmentView
  }>({ workspaceToken: '', view: EMPTY_ENVIRONMENT })

  useEffect(() => {
    if (!options.workspaceToken) {
      setRecord({ workspaceToken: '', view: EMPTY_ENVIRONMENT })
      return
    }
    if (!options.enabled) return

    const workspaceToken = options.workspaceToken
    let disposed = false
    let pending = false
    let rerun = false
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null

    setRecord((current) => current.workspaceToken === workspaceToken
      ? current
      : {
          workspaceToken,
          view: { ...EMPTY_ENVIRONMENT, state: 'loading' },
        })

    const schedule = (): void => {
      if (disposed || document.visibilityState === 'hidden') return
      if (timer !== null) globalThis.clearTimeout(timer)
      timer = globalThis.setTimeout(() => { void refresh() }, POLL_INTERVAL_MS)
    }

    const refresh = async (): Promise<void> => {
      if (disposed) return
      if (pending) {
        rerun = true
        return
      }
      pending = true
      if (timer !== null) {
        globalThis.clearTimeout(timer)
        timer = null
      }
      try {
        if (!('onekey' in window)) {
          throw new Error('desktop bridge unavailable')
        }
        const result = await window.onekey.workspace.environment({ workspaceToken })
        if (disposed) return
        if (!result.ok) {
          setRecord({
            workspaceToken,
            view: {
              ...EMPTY_ENVIRONMENT,
              state: 'error',
              clean: false,
              message: result.error.message,
            },
          })
          return
        }
        setRecord({
          workspaceToken,
          view: {
            ...result.value,
            message: '',
          },
        })
      } catch {
        if (disposed) return
        setRecord({
          workspaceToken,
          view: {
            ...EMPTY_ENVIRONMENT,
            state: 'error',
            clean: false,
            message: '暂时无法读取工作区状态。',
          },
        })
      } finally {
        pending = false
        if (rerun) {
          rerun = false
          void refresh()
        } else {
          schedule()
        }
      }
    }

    const refreshWhenVisible = (): void => {
      if (document.visibilityState !== 'hidden') void refresh()
    }
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    void refresh()

    return () => {
      disposed = true
      if (timer !== null) globalThis.clearTimeout(timer)
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [options.enabled, options.workspaceToken])

  return useMemo(() => {
    if (!options.workspaceToken) return EMPTY_ENVIRONMENT
    if (record.workspaceToken !== options.workspaceToken) {
      return { ...EMPTY_ENVIRONMENT, state: 'loading' }
    }
    return record.view
  }, [options.workspaceToken, record])
}
