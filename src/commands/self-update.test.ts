import { join } from 'node:path'
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
    execPath: 'node',
    realpath: async (p) => p,
    runCommand: scriptedRun({}),
    neutralDir: '/tmp',
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
    // No runnable command: an agent would execute manualCommand, and a blind
    // `npm i -g` for a non-npm install creates a shadowing copy.
    expect(r.manualCommand).toBeUndefined()
    expect(r.message).toContain('pnpm, yarn, bun')
  })

  it('fails with unknown-install when the install path matches no known cascade fragment', async () => {
    const c = ctx({
      argv1: '/opt/odd/node_modules/@motrix/cli/dist/bin/motrix.js',
    })
    const r = await runSelfUpdate({}, c)
    expect(r).toMatchObject({
      ok: false,
      reason: 'unknown-install',
      exitCode: EXIT.SELF_UPDATE_FAILED,
    })
    // Must NOT present npm as THE fix — that creates a shadowing copy when the
    // real installer was another manager. Warn, list options, and carry no
    // runnable command.
    expect(r.message).toMatch(/shadow/i)
    expect(r.message).toContain('pnpm, yarn, bun')
    expect(r.manualCommand).toBeUndefined()
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

  it('maps EINVALIDTAGNAME from npm view to bad-target during resolve', async () => {
    const r = await runSelfUpdate(
      { target: '.bad.' },
      ctx({
        runCommand: scriptedRun({
          view: {
            code: 1,
            stdout: '',
            stderr: 'npm error code EINVALIDTAGNAME\n',
          },
        }),
      })
    )
    expect(r).toMatchObject({
      ok: false,
      reason: 'bad-target',
      exitCode: EXIT.USAGE,
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
      expect.objectContaining({ cwd: '/tmp' })
    )
    expect(c.runCommand).toHaveBeenCalledWith(
      'node',
      // join()-built: the code joins the entry with the HOST separator.
      [
        join(NPM_ROOT, '@motrix', 'cli', 'dist', 'bin', 'motrix.js'),
        '--version',
      ],
      expect.objectContaining({ cwd: '/tmp' })
    )
  })

  it('updates via pnpm with the pnpm installer args', async () => {
    // pnpm is unbound, so verification is by PATH: give it a resolvable bin
    // reporting the target so the happy path confirms.
    const c = ctx({
      argv1: PNPM_BIN,
      whichBin: async () => '/Users/x/Library/pnpm/motrix',
      runCommand: scriptedRun({
        binVersion: { code: 0, stdout: '0.3.0\n', stderr: '' },
      }),
    })
    const r = await runSelfUpdate({}, c)
    expect(r).toMatchObject({ ok: true, changed: true, method: 'pnpm-global' })
    expect(c.runCommand).toHaveBeenCalledWith(
      'pnpm',
      ['add', '-g', '@motrix/cli@0.3.0'],
      expect.objectContaining({ cwd: '/tmp' })
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
          // EACCES fails before writing, so the existing 0.2.1 is intact.
          nodeVersion: { code: 0, stdout: '0.2.1\n', stderr: '' },
        }),
      })
    )
    expect(r).toMatchObject({
      ok: false,
      reason: 'install-failed',
      exitCode: EXIT.SELF_UPDATE_FAILED,
      // Old version still runs → not a mutated state.
      changed: false,
    })
    expect(r.message).toContain('EACCES')
    expect(r.message).toContain('resolving-eacces-permissions-errors')
    expect(r.message).toContain('Do NOT use sudo')
    // Old install intact → retry the forward install, not a rollback.
    expect(r.manualCommand).toBe('npm install -g @motrix/cli@0.3.0')
  })

  it('reports changed:true + a rollback when an install failure leaves state unconfirmable', async () => {
    const r = await runSelfUpdate(
      {},
      ctx({
        runCommand: scriptedRun({
          install: { code: 1, stdout: '', stderr: 'wrote files, then died\n' },
          // Post-failure the entry can't run → state indeterminate/broken.
          nodeVersion: { code: 1, stdout: '', stderr: 'corrupt' },
        }),
      })
    )
    expect(r).toMatchObject({
      ok: false,
      reason: 'install-failed',
      exitCode: EXIT.SELF_UPDATE_FAILED,
      changed: true,
    })
    expect(r.manualCommand).toBe('npm install -g @motrix/cli@0.2.1')
    expect(r.message).toContain('partially updated')
  })

  it('treats an install that errors but leaves the target active as success', async () => {
    const r = await runSelfUpdate(
      {},
      ctx({
        runCommand: scriptedRun({
          install: { code: 1, stdout: '', stderr: 'noisy postinstall\n' },
          // Target is actually live despite the non-zero exit.
          nodeVersion: { code: 0, stdout: '0.3.0\n', stderr: '' },
        }),
      })
    )
    expect(r).toMatchObject({
      ok: true,
      changed: true,
      to: '0.3.0',
      exitCode: EXIT.OK,
    })
    expect(r.warning).toContain('now active')
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
      // Installer exited 0 → the tree WAS mutated; report it honestly.
      changed: true,
    })
    // Recovery is a rollback to the previous version via the same manager,
    // not a re-run of the forward install.
    expect(r.manualCommand).toBe('npm install -g @motrix/cli@0.2.1')
    expect(r.message).toContain('motrix --version')
    expect(r.message).toContain('restore 0.2.1')
  })

  it('fails verify when a yarn install`s motrix on PATH reports the wrong version', async () => {
    // Unbound manager: we can`t prove the tree, so a PATH mismatch means the
    // update did not reach the installation the user runs — a failure, not a
    // warning (the caller must not read exit 0 here).
    const c = ctx({
      argv1:
        '/Users/x/.config/yarn/global/node_modules/@motrix/cli/dist/bin/motrix.js',
      whichBin: async () => '/other/bin/motrix',
      runCommand: scriptedRun({
        binVersion: { code: 0, stdout: '0.1.0\n', stderr: '' },
      }),
    })
    const r = await runSelfUpdate({}, c)
    expect(r).toMatchObject({
      ok: false,
      reason: 'verify-failed',
      exitCode: EXIT.SELF_UPDATE_FAILED,
      method: 'yarn-global',
    })
    // Unbound manager → no runnable rollback (it could hit a different tree);
    // the recovery is advisory.
    expect(r.manualCommand).toBeUndefined()
    expect(r.message).toContain('different installation')
  })

  it('succeeds (no warning) when a yarn install`s motrix on PATH reports the target', async () => {
    const c = ctx({
      argv1:
        '/Users/x/.config/yarn/global/node_modules/@motrix/cli/dist/bin/motrix.js',
      whichBin: async () => '/home/x/.yarn/bin/motrix',
      runCommand: scriptedRun({
        binVersion: { code: 0, stdout: '0.3.0\n', stderr: '' },
      }),
    })
    const r = await runSelfUpdate({}, c)
    expect(r).toMatchObject({ ok: true, changed: true, method: 'yarn-global' })
    expect(r.warning).toBeUndefined()
  })

  it('warns (but succeeds) when npm updated the bound root yet PATH is shadowed', async () => {
    const c = ctx({
      whichBin: async () => '/other/bin/motrix',
      runCommand: scriptedRun({
        // Bound npm entry reports the target…
        nodeVersion: { code: 0, stdout: '0.3.0\n', stderr: '' },
        // …but `motrix` first on PATH is a different, older install.
        binVersion: { code: 0, stdout: '0.1.0\n', stderr: '' },
      }),
    })
    const r = await runSelfUpdate({}, c)
    expect(r).toMatchObject({ ok: true, changed: true, method: 'npm-global' })
    expect(r.warning).toContain('shadowing')
  })

  it('fails verify (unverifiable) when an unbound install has no motrix on PATH (volta)', async () => {
    // Unbound manager + nothing on PATH = no evidence the update reached the
    // install we run. Not a confident success: exit 7, advisory recovery.
    const c = ctx({
      argv1:
        '/Users/x/.volta/tools/image/node_modules/@motrix/cli/dist/bin/motrix.js',
      whichBin: async () => null,
    })
    const r = await runSelfUpdate({}, c)
    expect(r).toMatchObject({
      ok: false,
      reason: 'verify-failed',
      exitCode: EXIT.SELF_UPDATE_FAILED,
      method: 'volta',
    })
    expect(r.manualCommand).toBeUndefined()
    expect(r.message).toContain('not on PATH')
  })

  it('updates via bun with the bun installer args', async () => {
    // Give bun a resolvable PATH bin reporting the target so verify confirms.
    const c = ctx({
      argv1:
        '/Users/x/.bun/install/global/node_modules/@motrix/cli/dist/bin/motrix.js',
      whichBin: async () => '/Users/x/.bun/bin/motrix',
      runCommand: scriptedRun({
        binVersion: { code: 0, stdout: '0.3.0\n', stderr: '' },
      }),
    })
    const r = await runSelfUpdate({}, c)
    expect(r).toMatchObject({ ok: true, changed: true, method: 'bun-global' })
    expect(c.runCommand).toHaveBeenCalledWith(
      'bun',
      ['add', '-g', '@motrix/cli@0.3.0'],
      expect.objectContaining({ cwd: '/tmp' })
    )
  })

  it('verifies pnpm via PATH: a target match on PATH is a confident success', async () => {
    // pnpm is not root-bound, so verify never queries `pnpm root -g` (which can
    // point at a different pnpm); it checks what `motrix` on PATH reports.
    const c = ctx({
      argv1: PNPM_BIN,
      whichBin: async () => '/Users/x/Library/pnpm/motrix',
      runCommand: scriptedRun({
        binVersion: { code: 0, stdout: '0.3.0\n', stderr: '' },
      }),
    })
    const r = await runSelfUpdate({}, c)
    expect(r).toMatchObject({ ok: true, changed: true, method: 'pnpm-global' })
    expect(r.warning).toBeUndefined()
  })

  it('fails verify when the installed entry does not run at all', async () => {
    const r = await runSelfUpdate(
      {},
      ctx({
        runCommand: scriptedRun({
          nodeVersion: { code: 1, stdout: '', stderr: 'boom' },
        }),
      })
    )
    expect(r).toMatchObject({
      ok: false,
      reason: 'verify-failed',
      exitCode: EXIT.SELF_UPDATE_FAILED,
      changed: true,
    })
    // Recovery command rolls back to `from` (0.2.1), not the forward install.
    expect(r.manualCommand).toBe('npm install -g @motrix/cli@0.2.1')
  })

  it('reports an installer spawn failure (e.g. ENOENT) as install-failed', async () => {
    const r = await runSelfUpdate(
      {},
      ctx({
        runCommand: scriptedRun({
          install: {
            code: null,
            stdout: '',
            stderr: '',
            spawnError: Object.assign(new Error('ENOENT'), {
              code: 'ENOENT',
            }),
          },
          // The manager binary never ran, so the existing 0.2.1 is untouched.
          nodeVersion: { code: 0, stdout: '0.2.1\n', stderr: '' },
        }),
      })
    )
    expect(r).toMatchObject({
      ok: false,
      reason: 'install-failed',
      exitCode: EXIT.SELF_UPDATE_FAILED,
      changed: false,
    })
    expect(r.message).toContain('spawn error')
  })
})
