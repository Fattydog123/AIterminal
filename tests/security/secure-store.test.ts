import assert from 'node:assert/strict'
import {
  access as accessFile,
  mkdtemp,
  readFile,
  readdir,
  rename as renameFile,
  rm,
  unlink as unlinkFile,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  SecureStore,
  SecureStoreError,
  type SecureStoreCipher
} from '../../src/main/security/secure-store.ts'

const XOR_MASK = 0xa7
const CIPHER_MARKER = 'test-cipher-v1:'

function createTestCipher(available = true): SecureStoreCipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString(value) {
      const bytes = Buffer.from(`${CIPHER_MARKER}${value}`, 'utf8')
      for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= XOR_MASK
      return bytes
    },
    decryptString(value) {
      const bytes = Buffer.from(value)
      for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= XOR_MASK
      const plaintext = bytes.toString('utf8')
      bytes.fill(0)
      if (!plaintext.startsWith(CIPHER_MARKER)) throw new Error('test decryption failed')
      return plaintext.slice(CIPHER_MARKER.length)
    }
  }
}

async function createTemporaryStorePath(): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'ai-terminal-secure-store-'))
  return { directory, filePath: join(directory, 'private-data.json') }
}

function recoveryBackupPath(filePath: string): string {
  return `${filePath}.secure-store.bak`
}

test('secure store round-trips text through a versioned purpose-bound envelope', async (context) => {
  const { directory, filePath } = await createTemporaryStorePath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const secret = 'sk-test-secure-store-fixture'
  const store = new SecureStore({ filePath, purpose: 'api-credentials', cipher: createTestCipher() })

  await store.write(secret)

  assert.equal(await store.read(), secret)
  const persisted = await readFile(filePath, 'utf8')
  const envelope = JSON.parse(persisted) as Record<string, unknown>
  assert.equal(envelope.format, 'ai-terminal.secure-store')
  assert.equal(envelope.version, 1)
  assert.equal(envelope.purpose, 'api-credentials')
  assert.doesNotMatch(persisted, new RegExp(secret))
})

test('corrupt envelopes and purpose mismatches fail closed', async (context) => {
  const { directory, filePath } = await createTemporaryStorePath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const cipher = createTestCipher()

  await writeFile(
    filePath,
    JSON.stringify({
      format: 'ai-terminal.secure-store',
      version: 1,
      purpose: 'api-credentials',
      ciphertext: '%%%invalid%%%'
    }),
    'utf8'
  )
  const corruptStore = new SecureStore({ filePath, purpose: 'api-credentials', cipher })
  await assert.rejects(corruptStore.read(), hasErrorCode('corrupt_data'))

  const sourceStore = new SecureStore({ filePath, purpose: 'api-credentials', cipher })
  await sourceStore.write('purpose-bound-value')
  const otherStore = new SecureStore({ filePath, purpose: 'conversation-history', cipher })
  await assert.rejects(otherStore.read(), hasErrorCode('purpose_mismatch'))
})

test('unavailable encryption blocks new writes and legacy reads', async (context) => {
  const { directory, filePath } = await createTemporaryStorePath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const legacySecret = 'legacy-plaintext-must-remain-unreleased'
  const store = new SecureStore({
    filePath,
    purpose: 'api-credentials',
    cipher: createTestCipher(false)
  })

  await assert.rejects(store.write('new-secret'), hasErrorCode('encryption_unavailable'))
  await writeFile(filePath, legacySecret, 'utf8')
  await assert.rejects(store.read(), hasErrorCode('encryption_unavailable'))
  assert.equal(await readFile(filePath, 'utf8'), legacySecret)
})

test('legacy plaintext is returned only after an encrypted in-place migration', async (context) => {
  const { directory, filePath } = await createTemporaryStorePath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const legacySecret = 'sk-test-secure-store-fixture'
  await writeFile(filePath, legacySecret, 'utf8')
  const store = new SecureStore({ filePath, purpose: 'api-credentials', cipher: createTestCipher() })

  assert.equal(await store.read(), legacySecret)

  const migrated = await readFile(filePath, 'utf8')
  assert.doesNotMatch(migrated, new RegExp(legacySecret))
  assert.equal((JSON.parse(migrated) as Record<string, unknown>).format, 'ai-terminal.secure-store')
  assert.equal(await store.read(), legacySecret)
})

test('a missing destination is recovered from its deterministic encrypted backup', async (context) => {
  const { directory, filePath } = await createTemporaryStorePath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const cipher = createTestCipher()
  const store = new SecureStore({ filePath, purpose: 'api-credentials', cipher })
  await store.write('recoverable-secret')
  const backupPath = recoveryBackupPath(filePath)
  await renameFile(filePath, backupPath)

  const recoveredStore = new SecureStore({ filePath, purpose: 'api-credentials', cipher })
  assert.equal(await recoveredStore.read(), 'recoverable-secret')
  assert.deepEqual(await readdir(directory), ['private-data.json'])
})

test('an unsafe leftover backup blocks reads and writes until it can be removed', async (context) => {
  const { directory, filePath } = await createTemporaryStorePath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const cipher = createTestCipher()
  const originalStore = new SecureStore({ filePath, purpose: 'api-credentials', cipher })
  await originalStore.write('current-secret')
  const backupPath = recoveryBackupPath(filePath)
  const currentBytes = await readFile(filePath)
  await writeFile(backupPath, currentBytes)

  const blockedStore = new SecureStore({
    filePath,
    purpose: 'api-credentials',
    cipher,
    io: {
      unlink: async (candidatePath) => {
        if (candidatePath === backupPath) {
          throw Object.assign(new Error('backup is locked'), { code: 'EPERM' })
        }
        await unlinkFile(candidatePath)
      }
    }
  })

  await assert.rejects(blockedStore.read(), hasErrorCode('read_failed'))
  await assert.rejects(blockedStore.write('new-secret'), hasErrorCode('write_failed'))
  assert.deepEqual(await readFile(filePath), currentBytes)
  assert.deepEqual(await readdir(directory), ['private-data.json', 'private-data.json.secure-store.bak'])
})

test('legacy migration never leaves or releases a plaintext recovery backup', async (context) => {
  const { directory, filePath } = await createTemporaryStorePath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const cipher = createTestCipher()
  const legacySecret = 'legacy-private-value-must-not-enter-backup'
  const backupPath = recoveryBackupPath(filePath)
  await writeFile(filePath, legacySecret, 'utf8')

  let firstReplacement = true
  let blockBackupCleanup = true
  const store = new SecureStore({
    filePath,
    purpose: 'api-credentials',
    cipher,
    io: {
      rename: async (sourcePath, destinationPath) => {
        if (firstReplacement && sourcePath.endsWith('.tmp') && destinationPath === filePath) {
          firstReplacement = false
          throw Object.assign(new Error('destination already exists'), { code: 'EEXIST' })
        }
        await renameFile(sourcePath, destinationPath)
      },
      unlink: async (candidatePath) => {
        if (blockBackupCleanup && candidatePath === backupPath) {
          throw Object.assign(new Error('backup is locked'), { code: 'EPERM' })
        }
        await unlinkFile(candidatePath)
      }
    }
  })

  await assert.rejects(store.read(), hasErrorCode('write_failed'))
  for (const persistedPath of [filePath, backupPath]) {
    const persisted = await readFile(persistedPath, 'utf8')
    assert.doesNotMatch(persisted, new RegExp(legacySecret))
    assert.equal((JSON.parse(persisted) as Record<string, unknown>).format, 'ai-terminal.secure-store')
  }

  blockBackupCleanup = false
  assert.equal(await store.read(), legacySecret)
  assert.deepEqual(await readdir(directory), ['private-data.json'])
})

test('concurrent operations on one store cannot consume an in-flight recovery backup', async (context) => {
  const { directory, filePath } = await createTemporaryStorePath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const cipher = createTestCipher()
  const originalStore = new SecureStore({ filePath, purpose: 'api-credentials', cipher })
  await originalStore.write('old-secret')

  let announceBackupReady!: () => void
  const backupReady = new Promise<void>((resolve) => {
    announceBackupReady = resolve
  })
  let releaseReplacement!: () => void
  const replacementGate = new Promise<void>((resolve) => {
    releaseReplacement = resolve
  })
  const backupPath = recoveryBackupPath(filePath)
  let temporaryReplacementAttempts = 0
  let destinationRemovalPaused = false
  let replacementReleased = false
  let backupAccessedBeforeRelease = false
  const store = new SecureStore({
    filePath,
    purpose: 'api-credentials',
    cipher,
    io: {
      access: async (candidatePath) => {
        if (candidatePath === backupPath && destinationRemovalPaused && !replacementReleased) {
          backupAccessedBeforeRelease = true
        }
        await accessFile(candidatePath)
      },
      rename: async (sourcePath, destinationPath) => {
        if (sourcePath.endsWith('.tmp') && destinationPath === filePath) {
          temporaryReplacementAttempts += 1
          throw Object.assign(new Error('replacement failed'), {
            code: temporaryReplacementAttempts === 1 ? 'EEXIST' : 'EBUSY'
          })
        }
        await renameFile(sourcePath, destinationPath)
      },
      unlink: async (candidatePath) => {
        if (candidatePath === filePath && !destinationRemovalPaused) {
          destinationRemovalPaused = true
          announceBackupReady()
          await replacementGate
        }
        await unlinkFile(candidatePath)
      }
    }
  })

  const pendingWrite = store.write('new-secret')
  await backupReady
  const pendingRead = store.read()
  const readTouchedInFlightBackup = backupAccessedBeforeRelease
  replacementReleased = true
  releaseReplacement()

  await assert.rejects(pendingWrite, hasErrorCode('write_failed'))
  assert.equal(readTouchedInFlightBackup, false)
  assert.equal(await pendingRead, 'old-secret')
  assert.deepEqual(await readdir(directory), ['private-data.json'])
})

test('failed atomic replacement leaves the previous encrypted file intact', async (context) => {
  const { directory, filePath } = await createTemporaryStorePath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const cipher = createTestCipher()
  const originalStore = new SecureStore({ filePath, purpose: 'api-credentials', cipher })
  await originalStore.write('old-secret')
  const before = await readFile(filePath)

  const failingStore = new SecureStore({
    filePath,
    purpose: 'api-credentials',
    cipher,
    io: {
      rename: async () => {
        throw new Error(`rename failed for ${filePath} with new-secret`)
      }
    }
  })

  await assert.rejects(failingStore.write('new-secret'), hasErrorCode('write_failed'))
  assert.deepEqual(await readFile(filePath), before)
  assert.equal(await originalStore.read(), 'old-secret')
  assert.deepEqual(await readdir(directory), ['private-data.json'])
})

for (const replacementErrorCode of ['EEXIST', 'EPERM'] as const) {
  test(`secure store replaces an existing encrypted file after ${replacementErrorCode}`, async (context) => {
    const { directory, filePath } = await createTemporaryStorePath()
    context.after(() => rm(directory, { recursive: true, force: true }))
    const cipher = createTestCipher()
    const originalStore = new SecureStore({ filePath, purpose: 'api-credentials', cipher })
    await originalStore.write('old-secret')

    let injectedReplacementFailure = false
    const replacementStore = new SecureStore({
      filePath,
      purpose: 'api-credentials',
      cipher,
      io: {
        rename: async (sourcePath, destinationPath) => {
          if (
            !injectedReplacementFailure &&
            sourcePath.endsWith('.tmp') &&
            destinationPath === filePath
          ) {
            injectedReplacementFailure = true
            throw Object.assign(new Error('destination already exists'), {
              code: replacementErrorCode
            })
          }
          await renameFile(sourcePath, destinationPath)
        }
      }
    })

    await replacementStore.write('new-secret')

    assert.equal(injectedReplacementFailure, true)
    assert.equal(await replacementStore.read(), 'new-secret')
    assert.deepEqual(await readdir(directory), ['private-data.json'])
  })
}

test('failed Windows replacement fallback restores the previous encrypted file', async (context) => {
  const { directory, filePath } = await createTemporaryStorePath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const cipher = createTestCipher()
  const originalStore = new SecureStore({ filePath, purpose: 'api-credentials', cipher })
  await originalStore.write('old-secret')
  const before = await readFile(filePath)

  let temporaryReplacementAttempts = 0
  const failingStore = new SecureStore({
    filePath,
    purpose: 'api-credentials',
    cipher,
    io: {
      rename: async (sourcePath, destinationPath) => {
        if (sourcePath.endsWith('.tmp') && destinationPath === filePath) {
          temporaryReplacementAttempts += 1
          const code = temporaryReplacementAttempts === 1 ? 'EEXIST' : 'EBUSY'
          throw Object.assign(new Error('replacement failed'), { code })
        }
        await renameFile(sourcePath, destinationPath)
      }
    }
  })

  await assert.rejects(failingStore.write('new-secret'), hasErrorCode('write_failed'))

  assert.equal(temporaryReplacementAttempts, 2)
  assert.deepEqual(await readFile(filePath), before)
  assert.equal(await originalStore.read(), 'old-secret')
  assert.deepEqual(await readdir(directory), ['private-data.json'])
})

test('cipher and filesystem failures do not expose values or absolute paths', async (context) => {
  const { directory, filePath } = await createTemporaryStorePath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const secret = 'sk-test-secure-store-fixture'
  const leakingCipher: SecureStoreCipher = {
    isEncryptionAvailable: () => true,
    encryptString: () => {
      throw new Error(`provider failed for ${secret} at ${filePath}`)
    },
    decryptString: () => {
      throw new Error(`provider failed for ${secret} at ${filePath}`)
    }
  }
  const store = new SecureStore({ filePath, purpose: 'api-credentials', cipher: leakingCipher })

  await assert.rejects(store.write(secret), (error: unknown) => {
    assert(error instanceof SecureStoreError)
    const exposed = `${String(error)}\n${error.stack ?? ''}`
    assert.doesNotMatch(exposed, new RegExp(secret))
    assert.doesNotMatch(exposed, new RegExp(escapeForRegExp(filePath)))
    return true
  })
})

function hasErrorCode(code: SecureStoreError['code']): (error: unknown) => boolean {
  return (error: unknown) => {
    assert(error instanceof SecureStoreError)
    assert.equal(error.code, code)
    return true
  }
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
