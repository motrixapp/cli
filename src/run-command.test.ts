import { describe, expect, it } from 'vitest'
import { runCommand } from './run-command'

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
