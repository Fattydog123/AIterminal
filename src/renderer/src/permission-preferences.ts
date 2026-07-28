export type Permission = 'ask' | 'auto' | 'full'

/**
 * Keep the renderer-side preference boundary tiny so startup can recover from
 * a missing, stale, or unavailable browser storage without blocking Agent.
 */
export interface PermissionPreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const PERMISSION_PREFERENCE_KEY = 'ai-terminal.permission-mode'
export const WORKSPACE_PERMISSION_PREFIX = 'ai-terminal.permission-mode.'

export function normalizePermission(value: unknown): Permission | null {
  return value === 'ask' || value === 'auto' || value === 'full' ? value : null
}

function storageKeyForWorkspace(workspaceToken: string): string {
  return workspaceToken ? `${WORKSPACE_PERMISSION_PREFIX}${workspaceToken}` : PERMISSION_PREFERENCE_KEY
}

export function readPermissionPreference(
  storage: PermissionPreferenceStorage | null | undefined = defaultStorage()
): Permission | null {
  if (!storage) return null
  try {
    return normalizePermission(storage.getItem(PERMISSION_PREFERENCE_KEY))
  } catch {
    return null
  }
}

export function readWorkspacePermissionPreference(
  workspaceToken: string,
  storage: PermissionPreferenceStorage | null | undefined = defaultStorage()
): Permission | null {
  if (!workspaceToken) return readPermissionPreference(storage)
  if (!storage) return null
  try {
    return normalizePermission(storage.getItem(storageKeyForWorkspace(workspaceToken)))
  } catch {
    return null
  }
}

export function writePermissionPreference(
  permission: Permission,
  storage: PermissionPreferenceStorage | null | undefined = defaultStorage()
): void {
  if (!storage || normalizePermission(permission) === null) return
  try {
    storage.setItem(PERMISSION_PREFERENCE_KEY, permission)
  } catch {
    // Browser storage can be unavailable in a locked-down or private profile.
  }
}

export function writeWorkspacePermissionPreference(
  workspaceToken: string,
  permission: Permission,
  storage: PermissionPreferenceStorage | null | undefined = defaultStorage()
): void {
  if (!workspaceToken) {
    writePermissionPreference(permission, storage)
    return
  }
  if (!storage || normalizePermission(permission) === null) return
  try {
    storage.setItem(storageKeyForWorkspace(workspaceToken), permission)
  } catch {
    // Browser storage can be unavailable in a locked-down or private profile.
  }
}

export function resolvePermissionPreference(
  bootstrapDefault: unknown,
  storage: PermissionPreferenceStorage | null | undefined = defaultStorage()
): Permission {
  return readPermissionPreference(storage) ?? normalizePermission(bootstrapDefault) ?? 'ask'
}

export function resolveWorkspacePermissionPreference(
  workspaceToken: string,
  bootstrapDefault: unknown,
  storage: PermissionPreferenceStorage | null | undefined = defaultStorage()
): Permission {
  if (!workspaceToken) return resolvePermissionPreference(bootstrapDefault, storage)
  return readWorkspacePermissionPreference(workspaceToken, storage)
    ?? resolvePermissionPreference(bootstrapDefault, storage)
}

function defaultStorage(): PermissionPreferenceStorage | null {
  try {
    if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) return null
    const storage = globalThis.localStorage
    return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
      ? storage
      : null
  } catch {
    return null
  }
}
