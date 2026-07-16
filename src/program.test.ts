import { CommanderError } from 'commander'
import { describe, expect, it } from 'vitest'
import { CliError, EXIT } from './errors'
import { applyExitOverride, buildProgram, exitCodeForError } from './program'

describe('exitCodeForError', () => {
  it('passes through a CliError exit code', () => {
    expect(exitCodeForError(new CliError(EXIT.NETWORK, 'down'))).toBe(
      EXIT.NETWORK
    )
    expect(exitCodeForError(new CliError(EXIT.AUTH, 'nope'))).toBe(EXIT.AUTH)
  })

  it('maps a commander usage error to EXIT.USAGE', () => {
    const err = new CommanderError(1, 'commander.unknownOption', 'bad option')
    expect(exitCodeForError(err)).toBe(EXIT.USAGE)
  })

  it('maps commander help/version (exitCode 0) to EXIT.OK', () => {
    const err = new CommanderError(0, 'commander.helpDisplayed', 'help')
    expect(exitCodeForError(err)).toBe(EXIT.OK)
  })

  it('maps any other throw to EXIT.SERVER', () => {
    expect(exitCodeForError(new Error('boom'))).toBe(EXIT.SERVER)
  })
})

describe('buildProgram', () => {
  it('registers the read + write subcommands', () => {
    const program = buildProgram()
    const names = program.commands.map((c) => c.name())
    for (const cmd of [
      'list',
      'stats',
      'open',
      'add',
      'pause',
      'resume',
      'remove',
      'watch',
      'pair',
      'describe',
      'skill',
    ]) {
      expect(names).toContain(cmd)
    }
  })

  it('exposes the global endpoint/token/json options', () => {
    const program = buildProgram()
    const flags = program.options.map((o) => o.long)
    expect(flags).toContain('--endpoint')
    expect(flags).toContain('--token')
    expect(flags).toContain('--json')
  })

  it('registers the open command with a --timeout option', () => {
    const program = buildProgram()
    const open = program.commands.find((c) => c.name() === 'open')
    expect(open).toBeDefined()
    expect(open?.options.some((o) => o.long === '--timeout')).toBe(true)
  })

  it('applyExitOverride makes a subcommand usage error THROW (→ exit 2)', async () => {
    // Regression: without per-subcommand exitOverride, a missing required
    // option commander-exits 1 instead of throwing into runMain's catch.
    const program = buildProgram()
    applyExitOverride(program)
    const err = await program
      .parseAsync(['add', 'https://example.com/f.iso'], { from: 'user' })
      .then(() => null)
      .catch((e) => e)
    expect(err).toBeInstanceOf(CommanderError)
    expect(exitCodeForError(err)).toBe(EXIT.USAGE)
  })
})
