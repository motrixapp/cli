import { describe, expect, it, vi } from 'vitest'
import { EXIT } from '../errors'
import type { RunResult } from '../run-command'
import { runSelfUpdate, type SelfUpdateCtx } from './self-update'

const NPM_ROOT = '/usr/local/lib/node_modules'
const NPM_BIN = `${NPM_ROOT}/@motrix/cli/dist/bin/motrix.js`
const PNPM_BIN =
  '/Users/x/Library/pnpm/global/5/node_modules/@motrix/cli/dist/bin/motrix.js'

/** A scripted runCommand: routes on the command + first arg. */
function scriptedRun(over: {
  view?: RunResult
  install?: RunResult
  root?: RunResult
  nodeVersion?: RunResult
  binVersion?: RunResult
}) {
  const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' })
  return vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
    if (args[0] === 'view') return over.view ?? ok('"0.3.0"\n')
    if (args[0] === 'root') return over.root ?? ok(`${NPM_ROOT}\n`)
    if (cmd === 'node') return over.nodeVersion ?? ok('0.3.0\n')
    if (args[0] === 'install' || args[0] === 'add' || args[1] === 'add') {
      return over.install ?? ok('added 1 package\n')
    }
    if (args[0] === '--version') return over.binVersion ?? ok('0.3.0\n')
    return ok('')
  })
}

function ctx(over: Partial<SelfUpdateCtx> = {}): SelfUpdateCtx {
  return {
    currentVersion: '0.2.1',
    argv1: NPM_BIN,
    env: {},
    realpath: async (p) => p,
    runCommand: scriptedRun({}),
    tmpdir: '/tmp',
    whichBin: async () => null,
    ...over,
  }
}

describe('runSelfUpdate — guards and refusals', () => {
  it('rejects a spec with shell metacharacters as bad-target without running anything', async () => {
    const c = ctx()
    const r = await runSelfUpdate({ target: '0.2.1 && rm -rf x' }, c)
    expect(r).toMatchObject({
      ok: false,
      reason: 'bad-target',
      exitCode: EXIT.USAGE,
    })
    expect(c.runCommand).not.toHaveBeenCalled()
  })

  it('fails with unknown-install when the current version is unreadable', async () => {
    const r = await runSelfUpdate({}, ctx({ currentVersion: null }))
    expect(r).toMatchObject({
      ok: false,
      reason: 'unknown-install',
      exitCode: EXIT.SELF_UPDATE_FAILED,
    })
    expect(r.manualCommand).toContain('npm install -g @motrix/cli')
  })

  it('refuses npx runs with exit 7 and a manual command, without installing', async () => {
    const c = ctx({
      argv1:
        '/Users/x/.npm/_npx/1a2b/node_modules/@motrix/cli/dist/bin/motrix.js',
    })
    const r = await runSelfUpdate({}, c)
    expect(r).toMatchObject({
      ok: false,
      reason: 'unsupported-ephemeral',
      exitCode: EXIT.SELF_UPDATE_FAILED,
    })
    // No installer invocation — `install`/`add` never appears. (Don't assert
    // on '-g': the detection probe `npm root -g` legitimately contains it.)
    const calls = vi.mocked(c.runCommand).mock.calls
    expect(
      calls.every(([, args]) => args[0] !== 'install' && args[0] !== 'add')
    ).toBe(true)
  })

  it('refuses a checkout with the git-pull manual command', async () => {
    const r = await runSelfUpdate(
      {},
      ctx({ argv1: '/Users/x/Work/code/motrix-app/cli/dist/bin/motrix.js' })
    )
    expect(r).toMatchObject({ ok: false, reason: 'unsupported-checkout' })
    expect(r.manualCommand).toContain('git pull')
  })

  it('reports already-up-to-date as a clean exit 0 no-op', async () => {
    const r = await runSelfUpdate(
      {},
      ctx({
        runCommand: scriptedRun({
          view: { code: 0, stdout: '"0.2.1"\n', stderr: '' },
        }),
      })
    )
    expect(r).toMatchObject({
      ok: true,
      changed: false,
      reason: 'already-up-to-date',
      exitCode: EXIT.OK,
    })
  })

  it('refuses an implicit-latest downgrade but allows an explicit one', async () => {
    const view: RunResult = { code: 0, stdout: '"0.1.0"\n', stderr: '' }
    const implicit = await runSelfUpdate(
      {},
      ctx({ runCommand: scriptedRun({ view }) })
    )
    expect(implicit).toMatchObject({
      ok: true,
      changed: false,
      reason: 'downgrade-refused',
      exitCode: EXIT.OK,
    })
    expect(implicit.message).toContain('motrix self-update 0.1.0')

    const explicit = await runSelfUpdate(
      { target: '0.1.0' },
      ctx({
        runCommand: scriptedRun({
          view,
          nodeVersion: { code: 0, stdout: '0.1.0\n', stderr: '' },
        }),
      })
    )
    expect(explicit).toMatchObject({ ok: true, changed: true, to: '0.1.0' })
  })

  it('maps a resolve failure to exit 3', async () => {
    const r = await runSelfUpdate(
      {},
      ctx({
        runCommand: scriptedRun({
          view: { code: 1, stdout: '', stderr: 'npm error code E404\n' },
        }),
      })
    )
    expect(r).toMatchObject({
      ok: false,
      reason: 'resolve-failed',
      exitCode: EXIT.NETWORK,
    })
  })
})

describe('runSelfUpdate — dry run', () => {
  it('stops after resolution and reports what it would run', async () => {
    const c = ctx()
    const r = await runSelfUpdate({ dryRun: true }, c)
    expect(r).toMatchObject({
      ok: true,
      changed: false,
      dryRun: true,
      from: '0.2.1',
      to: '0.3.0',
      method: 'npm-global',
      command: 'npm install -g @motrix/cli@0.3.0',
      exitCode: EXIT.OK,
    })
    // Resolution and detection ran, but never the installer itself.
    const calls = vi.mocked(c.runCommand).mock.calls
    expect(
      calls.every(([, args]) => args[0] !== 'install' && args[0] !== 'add')
    ).toBe(true)
  })
})

describe('runSelfUpdate — install and verify', () => {
  it('updates via npm and verifies the installed entry directly', async () => {
    const c = ctx()
    const r = await runSelfUpdate({}, c)
    expect(r).toMatchObject({
      ok: true,
      changed: true,
      from: '0.2.1',
      to: '0.3.0',
      method: 'npm-global',
      exitCode: EXIT.OK,
    })
    expect(c.runCommand).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', '@motrix/cli@0.3.0'],
      { cwd: '/tmp' }
    )
    expect(c.runCommand).toHaveBeenCalledWith(
      'node',
      [`${NPM_ROOT}/@motrix/cli/dist/bin/motrix.js`, '--version'],
      { cwd: '/tmp' }
    )
  })

  it('updates via pnpm with the pnpm installer args', async () => {
    const c = ctx({ argv1: PNPM_BIN })
    const r = await runSelfUpdate({}, c)
    expect(r).toMatchObject({ ok: true, changed: true, method: 'pnpm-global' })
    expect(c.runCommand).toHaveBeenCalledWith(
      'pnpm',
      ['add', '-g', '@motrix/cli@0.3.0'],
      { cwd: '/tmp' }
    )
  })

  it('surfaces installer output and the EACCES hint on failure, never sudo', async () => {
    const r = await runSelfUpdate(
      {},
      ctx({
        runCommand: scriptedRun({
          install: {
            code: 1,
            stdout: '',
            stderr: 'npm error EACCES: permission denied /usr/local/lib\n',
          },
        }),
      })
    )
    expect(r).toMatchObject({
      ok: false,
      reason: 'install-failed',
      exitCode: EXIT.SELF_UPDATE_FAILED,
    })
    expect(r.message).toContain('EACCES')
    expect(r.message).toContain('resolving-eacces-permissions-errors')
    expect(r.message).toContain('Do NOT use sudo')
    expect(r.manualCommand).toBe('npm install -g @motrix/cli@0.3.0')
  })

  it('fails verify when the npm-installed entry reports the wrong version', async () => {
    const r = await runSelfUpdate(
      {},
      ctx({
        runCommand: scriptedRun({
          nodeVersion: { code: 0, stdout: '0.2.9\n', stderr: '' },
        }),
      })
    )
    expect(r).toMatchObject({
      ok: false,
      reason: 'verify-failed',
      exitCode: EXIT.SELF_UPDATE_FAILED,
    })
  })

  it('only warns (never fails) on the PATH check for yarn installs', async () => {
    const c = ctx({
      argv1:
        '/Users/x/.yarn/global/node_modules/@motrix/cli/dist/bin/motrix.js',
      whichBin: async () => '/other/bin/motrix',
      runCommand: scriptedRun({
        binVersion: { code: 0, stdout: '0.1.0\n', stderr: '' },
      }),
    })
    const r = await runSelfUpdate({}, c)
    expect(r).toMatchObject({ ok: true, changed: true, method: 'yarn-global' })
    expect(r.warning).toContain('shadow')
  })

  it('succeeds with a warning when no motrix is found on PATH (volta)', async () => {
    const c = ctx({
      argv1:
        '/Users/x/.volta/tools/image/node_modules/@motrix/cli/dist/bin/motrix.js',
      whichBin: async () => null,
    })
    const r = await runSelfUpdate({}, c)
    expect(r).toMatchObject({ ok: true, changed: true, method: 'volta' })
    expect(r.warning).toBeDefined()
  })
})
