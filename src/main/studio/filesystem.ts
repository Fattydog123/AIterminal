import { constants } from 'node:fs'
import { access, chmod, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { StudioError } from './errors.ts'

export const ensureDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true })
}

export const readJson = async <T>(filePath: string, fallback?: T): Promise<T> => {
  try {
    const details = await lstat(filePath)
    if (details.isSymbolicLink()) throw new StudioError('symlink-denied', `拒绝读取符号链接 JSON：${path.basename(filePath)}`)
    if (!details.isFile() || details.size > 128 * 1024 * 1024) {
      throw new StudioError('json-size-denied', `JSON 文件不是普通文件或超过 128 MiB：${path.basename(filePath)}`)
    }
    return JSON.parse(await readFile(filePath, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fallback !== undefined) return fallback
    if (error instanceof SyntaxError) throw new StudioError('invalid-json', `JSON 文件损坏：${path.basename(filePath)}`)
    throw error
  }
}

/** Write in the same directory, fsync, then atomically replace the destination. */
export const atomicWriteFile = async (filePath: string, data: string | Uint8Array): Promise<void> => {
  await ensureDirectory(path.dirname(filePath))
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  try {
    await rename(temporary, filePath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM') {
      await rm(temporary, { force: true })
      throw error
    }
    const backup = `${filePath}.${process.pid}.${crypto.randomUUID()}.bak`
    let originalMoved = false
    try {
      await rename(filePath, backup)
      originalMoved = true
      await rename(temporary, filePath)
    } catch (replacementError) {
      if (originalMoved) {
        try {
          await access(filePath, constants.F_OK)
        } catch {
          await rename(backup, filePath).catch(() => undefined)
        }
      }
      await rm(temporary, { force: true })
      throw replacementError
    }
    // Replacement has committed. Antivirus/indexer locks on the obsolete backup
    // must not turn a successful save into a reported failure.
    await rm(backup, { force: true }).catch(() => undefined)
  }
}

export const atomicWriteJson = async (filePath: string, value: unknown): Promise<void> =>
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`)

export const resolveInside = (root: string, candidate: string): string => {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, candidate)
  const relative = path.relative(resolvedRoot, resolved)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return resolved
  throw new StudioError('path-outside-project', '路径必须位于项目目录内')
}

export const assertRegularFile = async (filePath: string, maximumBytes?: number): Promise<number> => {
  const details = await stat(filePath)
  if (!details.isFile()) throw new StudioError('not-a-file', '目标不是普通文件')
  if (maximumBytes !== undefined && details.size > maximumBytes) {
    throw new StudioError('file-too-large', `文件超过大小限制（${maximumBytes} 字节）`)
  }
  return details.size
}

export const safeFilename = (value: string, fallback = 'untitled'): string => {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120)
  return cleaned && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? cleaned : fallback
}

export const writePrivateJson = async (filePath: string, value: unknown): Promise<void> => {
  await atomicWriteJson(filePath, value)
  await chmod(filePath, 0o600).catch(() => undefined)
}
