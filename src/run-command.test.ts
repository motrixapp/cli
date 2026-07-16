import { describe, expect, it } from 'vitest'
import { escapeForCmdShell, runCommand } from './run-command'

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
  })
})
