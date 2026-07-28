import assert from 'node:assert/strict'
import test from 'node:test'
import type { IDisposable, IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty'
import { TerminalService } from '../../src/main/services/terminal-service.ts'

interface Listener<T> {
  listener: (event: T) => void
  disposed: boolean
}

class FakePty implements IPty {
  readonly pid = 42
  cols: number
  rows: number
  readonly process = 'fake-shell'
  handleFlowControl = false
  readonly writes: Array<string | Buffer> = []
  readonly resizes: Array<[number, number]> = []
  readonly killSignals: Array<string | undefined> = []
  readonly dataListeners: Array<Listener<string>> = []
  readonly exitListeners: Array<Listener<{ exitCode: number; signal?: number }>> = []

  constructor(columns: number, rows: number) {
    this.cols = columns
    this.rows = rows
  }

  readonly onData = (listener: (data: string) => void): IDisposable => {
    const subscription = { listener, disposed: false }
    this.dataListeners.push(subscription)
    return { dispose: () => { subscription.disposed = true } }
  }

  readonly onExit = (listener: (event: { exitCode: number; signal?: number }) => void): IDisposable => {
    const subscription = { listener, disposed: false }
    this.exitListeners.push(subscription)
    return { dispose: () => { subscription.disposed = true } }
  }

  write(data: string | Buffer): void {
    this.writes.push(data)
  }

  resize(columns: number, rows: number): void {
    this.cols = columns
    this.rows = rows
    this.resizes.push([columns, rows])
  }

  clear(): void {}
  pause(): void {}
  resume(): void {}

  kill(signal?: string): void {
    this.killSignals.push(signal)
  }

  emitData(data: string): void {
    for (const subscription of this.dataListeners) {
      if (!subscription.disposed) subscription.listener(data)
    }
  }

  emitExit(exitCode: number): void {
    for (const subscription of this.exitListeners) {
      if (!subscription.disposed) subscription.listener({ exitCode })
    }
  }
}

function createHarness(): {
  service: TerminalService
  terminals: FakePty[]
  starts: Array<{ file: string; args: string[] | string; options: IPtyForkOptions | IWindowsPtyForkOptions }>
  outputs: Array<{ terminalId: string; data: string }>
  exits: Array<{ terminalId: string; code: number | null }>
} {
  const terminals: FakePty[] = []
  const starts: Array<{ file: string; args: string[] | string; options: IPtyForkOptions | IWindowsPtyForkOptions }> = []
  const outputs: Array<{ terminalId: string; data: string }> = []
  const exits: Array<{ terminalId: string; code: number | null }> = []
  const service = new TerminalService({
    onOutput: (event) => outputs.push(event),
    onExit: (terminalId, code) => exits.push({ terminalId, code }),
    spawn: (file, args, options) => {
      starts.push({ file, args, options })
      const terminal = new FakePty(options.cols ?? 80, options.rows ?? 24)
      terminals.push(terminal)
      return terminal
    }
  })
  return { service, terminals, starts, outputs, exits }
}

test('starts a PTY with the xterm dimensions and forwards stdin, resize, output, and exit', () => {
  const harness = createHarness()
  const session = harness.service.start('C:\\workspace', 'pwsh.exe', 132, 43)

  assert.match(session.id, /^term_[0-9a-f-]{36}$/u)
  assert.equal(session.cwd, 'C:\\workspace')
  assert.equal(harness.starts.length, 1)
  assert.equal(harness.starts[0]?.file, 'pwsh.exe')
  assert.deepEqual(harness.starts[0]?.args, [])
  assert.equal(harness.starts[0]?.options.cwd, 'C:\\workspace')
  assert.equal(harness.starts[0]?.options.name, 'xterm-256color')
  assert.equal(harness.starts[0]?.options.cols, 132)
  assert.equal(harness.starts[0]?.options.rows, 43)
  assert.equal(harness.starts[0]?.options.env?.TERM, 'xterm-256color')
  if (process.platform === 'win32') {
    assert.equal((harness.starts[0]?.options as IWindowsPtyForkOptions).useConpty, true)
  }

  assert.equal(harness.service.write(session.id, 'echo ready\r'), true)
  assert.deepEqual(harness.terminals[0]?.writes, ['echo ready\r'])
  assert.equal(harness.service.resize(session.id, 160, 52), true)
  assert.deepEqual(harness.terminals[0]?.resizes, [[160, 52]])

  harness.terminals[0]?.emitData('\u001b[2Jready\r\n')
  assert.deepEqual(harness.outputs, [{ terminalId: session.id, data: '\u001b[2Jready\r\n' }])

  harness.terminals[0]?.emitExit(7)
  assert.deepEqual(harness.exits, [{ terminalId: session.id, code: 7 }])
  assert.equal(harness.service.write(session.id, 'late'), false)
  assert.equal(harness.service.resize(session.id, 80, 24), false)
  assert.equal(harness.service.stop(session.id), false)
})

test('bounds PTY dimensions and chunks output to the renderer event contract', () => {
  const harness = createHarness()
  const session = harness.service.start('C:\\workspace', 'cmd.exe', Number.NaN, Number.POSITIVE_INFINITY)

  assert.equal(harness.starts[0]?.options.cols, 80)
  assert.equal(harness.starts[0]?.options.rows, 24)
  assert.equal(harness.service.resize(session.id, 1, 9_000), true)
  assert.deepEqual(harness.terminals[0]?.resizes, [[2, 1_000]])

  harness.terminals[0]?.emitData('x'.repeat(16 * 1024 + 7))
  assert.deepEqual(harness.outputs.map((event) => event.data.length), [16 * 1024, 7])
  assert.equal(harness.outputs.every((event) => event.terminalId === session.id), true)
})

test('stop and dispose kill PTYs once, release listeners, and never publish synthetic exits', () => {
  const harness = createHarness()
  const first = harness.service.start('C:\\workspace', 'cmd.exe')
  harness.service.start('C:\\workspace', 'cmd.exe')

  assert.equal(harness.service.stop(first.id), true)
  assert.deepEqual(harness.terminals[0]?.killSignals, [undefined])
  harness.terminals[0]?.emitData('late output')
  harness.terminals[0]?.emitExit(0)

  harness.service.dispose()
  harness.service.dispose()
  assert.deepEqual(harness.terminals[1]?.killSignals, [undefined])
  assert.deepEqual(harness.outputs, [])
  assert.deepEqual(harness.exits, [])
  assert.throws(() => harness.service.start('C:\\workspace'), /disposed/u)
})

test('enforces the active terminal cap and returns false for missing sessions', () => {
  const harness = createHarness()
  for (let index = 0; index < 8; index += 1) {
    harness.service.start('C:\\workspace', 'cmd.exe')
  }

  assert.throws(() => harness.service.start('C:\\workspace', 'cmd.exe'), /max_terminals/u)
  assert.equal(harness.service.write('term_missing', 'input'), false)
  assert.equal(harness.service.resize('term_missing', 80, 24), false)
  assert.equal(harness.service.stop('term_missing'), false)
  harness.service.dispose()
})
