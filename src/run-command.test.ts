import { describe, expect, it } from 'vitest'
import { escapeForCmdShell, isCommandMissing, runCommand } from './run-command'

describe('escapeForCmdShell', () => {
  it('wraps a plain arg in double quotes', () => {
    expect(escapeForCmdShell('arg')).toBe('"arg"')
  })

  it('quotes an arg containing spaces so cmd.exe keeps it as one argument', () => {
    expect(escapeForCmdShell('C:\\Users\\John Smith\\motrix.js')).toBe(
      '"C:\\Users\\John Smith\\motrix.js"'
    )
  })

  it('doubles embedded double quotes', () => {
    expect(escapeForCmdShell('a"b')).toBe('"a""b"')
  })

  it('leaves ^ unchanged inside the quotes (cmd.exe treats it literally there)', () => {
    expect(escapeForCmdShell('^0.2.0')).toBe('"^0.2.0"')
  })

  it('quotes the command itself the same way (e.g. the default Windows node.exe path)', () => {
    expect(escapeForCmdShell('C:\\Program Files\\nodejs\\node.exe')).toBe(
      '"C:\\Program Files\\nodejs\\node.exe"'
    )
  })
})

describe('runCommand', () => {
  it('captures stdout and the exit code', async () => {
    const r = await runCommand('node', [
      '-e',
      'process.stdout.write("out"); process.exit(0)',
    ])
    expect(r).toMatchObject({ code: 0, stdout: 'out' })
  })

  it('captures stderr and a non-zero exit code', async () => {
    const r = await runCommand('node', [
      '-e',
      'process.stderr.write("bad"); process.exit(3)',
    ])
    expect(r).toMatchObject({ code: 3, stderr: 'bad' })
  })

  it('reports a spawn failure as code null with the error attached', async () => {
    const r = await runCommand('motrix-test-no-such-binary-xyz', [])
    expect(r.code).toBe(null)
    expect(r.spawnError).toBeDefined()
    // A POSIX ENOENT is a missing command; on win32 it surfaces via 9009.
    if (process.platform !== 'win32') expect(r.commandMissing).toBe(true)
  })

  it('kills a process that exceeds the timeout and flags timedOut', async () => {
    const r = await runCommand('node', ['-e', 'setTimeout(() => {}, 10000)'], {
      timeoutMs: 200,
    })
    expect(r.timedOut).toBe(true)
    // Killed → no clean exit code.
    expect(r.code).toBe(null)
  })

  it('caps captured output and flags truncation', async () => {
    const r = await runCommand(
      'node',
      ['-e', 'process.stdout.write("x".repeat(50000))'],
      { maxBuffer: 1000 }
    )
    expect(r.truncated).toBe(true)
    expect(r.stdout.length).toBeLessThanOrEqual(1000)
  })
})

describe('isCommandMissing', () => {
  it('flags cmd.exe 9009 as a missing command on win32', () => {
    expect(isCommandMissing(9009, '', 'win32')).toBe(true)
  })

  it('flags the cmd.exe "is not recognized" phrase on win32', () => {
    expect(
      isCommandMissing(
        1,
        "'npm' is not recognized as an internal or external command",
        'win32'
      )
    ).toBe(true)
  })

  it('does NOT flag a real tool error like npm E404 (exit 1, "not found")', () => {
    // The classifier must be narrow: npm's own "404 Not Found" must not read
    // as a missing binary, or resolve would wrongly fall back / bail.
    expect(
      isCommandMissing(
        1,
        'npm error code E404\nnpm error 404 Not Found',
        'win32'
      )
    ).toBe(false)
  })

  it('is never true on POSIX (missing there is a spawn ENOENT, handled separately)', () => {
    expect(isCommandMissing(9009, 'is not recognized', 'linux')).toBe(false)
    expect(isCommandMissing(127, 'command not found', 'darwin')).toBe(false)
  })
})
