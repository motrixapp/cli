import { describe, expect, it } from 'vitest'
import {
  escapeCmdArgument,
  escapeCmdCommand,
  isCommandMissing,
  runCommand,
} from './run-command'

// Expected outputs mirror cross-spawn's escape.js exactly (the CVE-2024-27980
// reference). They look busy because they are correct: under `cmd /c` a `^"`
// collapses to a literal `"` for CommandLineToArgvW, `^ ` to a literal space.
describe('escapeCmdArgument', () => {
  it('wraps a plain arg and caret-escapes the added quotes', () => {
    expect(escapeCmdArgument('arg')).toBe('^"arg^"')
  })

  it('caret-escapes spaces inside the arg (path with a space)', () => {
    expect(escapeCmdArgument('C:\\Users\\John Smith\\motrix.js')).toBe(
      '^"C:\\Users\\John^ Smith\\motrix.js^"'
    )
  })

  it('doubles backslash runs before a quote and escapes the quote (argv layer)', () => {
    // a\"b : the pre-quote backslash run is doubled, then the quote escaped.
    expect(escapeCmdArgument('a"b')).toBe('^"a\\^"b^"')
  })

  it('caret-escapes ^ so a caret range survives cmd.exe', () => {
    expect(escapeCmdArgument('^0.2.0')).toBe('^"^^0.2.0^"')
  })

  it('neutralizes % and ! (which double-quotes alone do NOT stop in cmd.exe)', () => {
    expect(escapeCmdArgument('a%b!c')).toBe('^"a^%b^!c^"')
  })

  it('double-escapes metacharacters for a .cmd/.bat shim (BatBadBut)', () => {
    expect(escapeCmdArgument('a&b', true)).toBe('^^^"a^^^&b^^^"')
  })

  it('leaves a normal package spec free of metacharacters intact (only the wrap escapes)', () => {
    expect(escapeCmdArgument('@motrix/cli@0.3.0')).toBe('^"@motrix/cli@0.3.0^"')
  })
})

describe('escapeCmdCommand', () => {
  it('caret-escapes a command path with a space, without quoting it', () => {
    expect(escapeCmdCommand('C:\\Program Files\\nodejs\\node.exe')).toBe(
      'C:\\Program^ Files\\nodejs\\node.exe'
    )
  })

  it('leaves a bare command name untouched', () => {
    expect(escapeCmdCommand('npm')).toBe('npm')
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
