import { randomUUID } from 'node:crypto'
import { spawn as spawnPty, type IDisposable, type IPty } from 'node-pty'

const MAX_TERMINALS = 8
const DEFAULT_COLUMNS = 80
const DEFAULT_ROWS = 24
const MIN_COLUMNS = 2
const MIN_ROWS = 1
const MAX_COLUMNS = 1_000
const MAX_ROWS = 1_000
const MAX_OUTPUT_EVENT_CHARACTERS = 16 * 1024

export interface TerminalSession {
  readonly id: string
  readonly cwd: string
}

export interface TerminalOutputEvent {
  terminalId: string
  data: string
}

export interface TerminalServiceOptions {
  onOutput: (event: TerminalOutputEvent) => void
  onExit: (terminalId: string, code: number | null) => void
  spawn?: typeof spawnPty
}

interface TerminalProcess {
  readonly pty: IPty
  readonly dataSubscription: IDisposable
  exitSubscription: IDisposable
  exited: boolean
}

export class TerminalService {
  readonly #processes = new Map<string, TerminalProcess>()
  readonly #onOutput: (event: TerminalOutputEvent) => void
  readonly #onExit: (terminalId: string, code: number | null) => void
  readonly #spawn: typeof spawnPty
  #disposed = false

  constructor(options: TerminalServiceOptions) {
    this.#onOutput = options.onOutput
    this.#onExit = options.onExit
    this.#spawn = options.spawn ?? spawnPty
  }

  start(cwd: string, shell?: string, columns = DEFAULT_COLUMNS, rows = DEFAULT_ROWS): TerminalSession {
    if (this.#disposed) throw new Error('disposed')
    if (this.#processes.size >= MAX_TERMINALS) throw new Error('max_terminals')

    const id = `term_${randomUUID()}`
    const dimensions = normalizeDimensions(columns, rows)
    const shellCmd = shell ?? defaultShell()
    const args = process.platform === 'win32' ? [] : ['--login']
    const terminal = this.#spawn(shellCmd, args, {
      name: 'xterm-256color',
      cols: dimensions.columns,
      rows: dimensions.rows,
      cwd,
      env: terminalEnvironment(),
      ...(process.platform === 'win32' ? { useConpty: true } : {})
    })

    const entry: TerminalProcess = {
      pty: terminal,
      dataSubscription: terminal.onData((data) => {
        for (const chunk of outputChunks(data)) {
          this.#onOutput({ terminalId: id, data: chunk })
        }
      }),
      // Assigned immediately below; the placeholder is never externally visible.
      exitSubscription: { dispose() {} },
      exited: false
    }
    entry.exitSubscription = terminal.onExit(({ exitCode }) => {
      this.#finish(id, Number.isInteger(exitCode) ? exitCode : null)
    })
    this.#processes.set(id, entry)
    return { id, cwd }
  }

  write(terminalId: string, data: string): boolean {
    const entry = this.#processes.get(terminalId)
    if (!entry || entry.exited) return false
    try {
      entry.pty.write(data)
      return true
    } catch {
      return false
    }
  }

  resize(terminalId: string, columns: number, rows: number): boolean {
    const entry = this.#processes.get(terminalId)
    if (!entry || entry.exited) return false
    const dimensions = normalizeDimensions(columns, rows)
    try {
      entry.pty.resize(dimensions.columns, dimensions.rows)
      return true
    } catch {
      return false
    }
  }

  stop(terminalId: string): boolean {
    const entry = this.#processes.get(terminalId)
    if (!entry || entry.exited) return false
    this.#remove(terminalId, entry)
    try {
      entry.pty.kill()
    } catch {
      // The PTY may have exited between lookup and termination.
    }
    return true
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const [terminalId, entry] of this.#processes) {
      this.#remove(terminalId, entry)
      try {
        entry.pty.kill()
      } catch {
        // Shutdown is best effort after listener ownership has been released.
      }
    }
  }

  #finish(terminalId: string, code: number | null): void {
    const entry = this.#processes.get(terminalId)
    if (!entry || entry.exited) return
    this.#remove(terminalId, entry)
    this.#onExit(terminalId, code)
  }

  #remove(terminalId: string, entry: TerminalProcess): void {
    entry.exited = true
    entry.dataSubscription.dispose()
    entry.exitSubscription.dispose()
    this.#processes.delete(terminalId)
  }
}

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC?.trim() || 'cmd.exe'
  }
  return process.env.SHELL?.trim() || '/bin/bash'
}

function terminalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key]
  }
  return env
}

function normalizeDimensions(columns: number, rows: number): { columns: number; rows: number } {
  return {
    columns: normalizeDimension(columns, DEFAULT_COLUMNS, MIN_COLUMNS, MAX_COLUMNS),
    rows: normalizeDimension(rows, DEFAULT_ROWS, MIN_ROWS, MAX_ROWS)
  }
}

function normalizeDimension(value: number, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(value)))
}

function outputChunks(data: string): string[] {
  if (data.length <= MAX_OUTPUT_EVENT_CHARACTERS) return data.length > 0 ? [data] : []
  const chunks: string[] = []
  for (let offset = 0; offset < data.length; offset += MAX_OUTPUT_EVENT_CHARACTERS) {
    chunks.push(data.slice(offset, offset + MAX_OUTPUT_EVENT_CHARACTERS))
  }
  return chunks
}
