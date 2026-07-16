import { describe, expect, it, vi } from 'vitest'
import { type ResolveCtx, resolveTargetVersion } from './registry'
import type { RunResult } from './run-command'

function ctx(
  result: Partial<RunResult>,
  over: Partial<ResolveCtx> = {}
): ResolveCtx {
  return {
    runCommand: vi
      .fn()
      .mockResolvedValue({ code: 0, stdout: '', stderr: '', ...result }),
    tmpdir: '/tmp',
    allowPnpmFallback: false,
    ...over,
  }
}

describe('resolveTargetVersion', () => {
  it('resolves an exact/dist-tag spec (npm view prints a JSON string)', async () => {
    const c = ctx({ stdout: '"0.3.0"\n' })
    const r = await resolveTargetVersion('latest', c)
    expect(r).toEqual({ ok: true, version: '0.3.0' })
    expect(c.runCommand).toHaveBeenCalledWith(
      'npm',
      ['view', '@motrix/cli@latest', 'version', '--json'],
      { cwd: '/tmp' }
    )
  })

  it('resolves a range to the highest match (npm view prints an array)', async () => {
    const c = ctx({ stdout: '["0.1.0","0.2.1","0.2.0"]\n' })
    const r = await resolveTargetVersion('0.2', c)
    expect(r).toEqual({ ok: true, version: '0.2.1' })
  })

  it('treats empty output (non-matching range, exit 0) as resolve-failed', async () => {
    const r = await resolveTargetVersion('99', ctx({ stdout: '\n' }))
    expect(r).toMatchObject({ ok: false, reason: 'resolve-failed' })
  })

  it('maps EINVALIDTAGNAME to bad-target', async () => {
    const r = await resolveTargetVersion(
      '.bad.',
      ctx({ code: 1, stderr: 'npm error code EINVALIDTAGNAME\n' })
    )
    expect(r).toMatchObject({ ok: false, reason: 'bad-target' })
  })

  it('maps E404 to resolve-failed with a not-found message', async () => {
    const r = await resolveTargetVersion(
      'nope-tag',
      ctx({ code: 1, stderr: 'npm error code E404\nnpm error 404 Not Found' })
    )
    expect(r).toMatchObject({ ok: false, reason: 'resolve-failed' })
    if (!r.ok) expect(r.message).toContain('not found')
  })

  it('falls back to pnpm view when npm is missing and fallback is allowed', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        code: null,
        stdout: '',
        stderr: '',
        spawnError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      })
      .mockResolvedValueOnce({ code: 0, stdout: '"0.3.0"\n', stderr: '' })
    const r = await resolveTargetVersion('latest', {
      runCommand: run,
      tmpdir: '/tmp',
      allowPnpmFallback: true,
    })
    expect(r).toEqual({ ok: true, version: '0.3.0' })
    expect(run).toHaveBeenNthCalledWith(
      2,
      'pnpm',
      ['view', '@motrix/cli@latest', 'version', '--json'],
      { cwd: '/tmp' }
    )
  })

  it('reports npm-missing as resolve-failed when no fallback is allowed', async () => {
    const r = await resolveTargetVersion(
      'latest',
      ctx({ code: null, spawnError: Object.assign(new Error('x'), {}) })
    )
    expect(r).toMatchObject({ ok: false, reason: 'resolve-failed' })
  })

  it('treats unparseable output as resolve-failed', async () => {
    const r = await resolveTargetVersion('latest', ctx({ stdout: 'not json' }))
    expect(r).toMatchObject({ ok: false, reason: 'resolve-failed' })
  })
})
