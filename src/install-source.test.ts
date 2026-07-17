import { describe, expect, it, vi } from 'vitest'
import {
  type DetectCtx,
  detectInstallSource,
  installArgsFor,
} from './install-source'

const NPM_ROOT = '/usr/local/lib/node_modules'

function ctx(over: Partial<DetectCtx> = {}): DetectCtx {
  return {
    argv1: `${NPM_ROOT}/@motrix/cli/dist/bin/motrix.js`,
    realpath: async (p) => p,
    env: {},
    runCommand: vi
      .fn()
      .mockResolvedValue({ code: 0, stdout: `${NPM_ROOT}\n`, stderr: '' }),
    neutralDir: '/tmp',
    ...over,
  }
}

describe('detectInstallSource — refusals', () => {
  it('refuses npx one-off runs', async () => {
    const r = await detectInstallSource(
      ctx({
        argv1:
          '/Users/x/.npm/_npx/1a2b/node_modules/@motrix/cli/dist/bin/motrix.js',
      })
    )
    expect(r).toMatchObject({ executable: false, kind: 'npx' })
    if (!r.executable) expect(r.manualCommand).toContain('npm install -g')
  })

  it('refuses pnpm dlx runs', async () => {
    const r = await detectInstallSource(
      ctx({
        argv1:
          '/Users/x/.cache/pnpm/dlx/ab12/node_modules/@motrix/cli/dist/bin/motrix.js',
      })
    )
    expect(r).toMatchObject({ executable: false, kind: 'pnpm-dlx' })
  })

  it('refuses bunx cache runs', async () => {
    const r = await detectInstallSource(
      ctx({
        argv1:
          '/Users/x/.bun/install/cache/@motrix/cli@0.2.1/dist/bin/motrix.js',
      })
    )
    expect(r).toMatchObject({ executable: false, kind: 'bunx' })
  })

  it('refuses a source checkout (no node_modules ancestor)', async () => {
    const r = await detectInstallSource(
      ctx({ argv1: '/Users/x/Work/code/motrix-app/cli/dist/bin/motrix.js' })
    )
    expect(r).toMatchObject({ executable: false, kind: 'checkout' })
    if (!r.executable) expect(r.manualCommand).toContain('git pull')
  })

  it('falls back to unknown when npm root -g does not contain the path', async () => {
    const r = await detectInstallSource(
      ctx({
        argv1: '/opt/odd/node_modules/@motrix/cli/dist/bin/motrix.js',
      })
    )
    expect(r).toMatchObject({ executable: false, kind: 'unknown' })
  })

  it('falls back to unknown when npm itself cannot be spawned', async () => {
    const r = await detectInstallSource(
      ctx({
        argv1: '/opt/odd/node_modules/@motrix/cli/dist/bin/motrix.js',
        runCommand: vi.fn().mockResolvedValue({
          code: null,
          stdout: '',
          stderr: '',
          spawnError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
        }),
      })
    )
    expect(r).toMatchObject({ executable: false, kind: 'unknown' })
  })
})

describe('detectInstallSource — executable sources', () => {
  it('detects volta', async () => {
    const r = await detectInstallSource(
      ctx({
        argv1:
          '/Users/x/.volta/tools/image/packages/@motrix/cli/lib/node_modules/@motrix/cli/dist/bin/motrix.js',
      })
    )
    expect(r).toMatchObject({ executable: true, kind: 'volta' })
  })

  it('detects pnpm-global via $PNPM_HOME without spawning anything', async () => {
    const run = vi.fn()
    const r = await detectInstallSource(
      ctx({
        argv1:
          '/custom/pnpm-home/global/5/node_modules/@motrix/cli/dist/bin/motrix.js',
        env: { PNPM_HOME: '/custom/pnpm-home' },
        runCommand: run,
      })
    )
    expect(r).toMatchObject({ executable: true, kind: 'pnpm-global' })
    expect(run).not.toHaveBeenCalled()
  })

  it('detects pnpm-global via the default macOS layout', async () => {
    const r = await detectInstallSource(
      ctx({
        argv1:
          '/Users/x/Library/pnpm/global/5/node_modules/@motrix/cli/dist/bin/motrix.js',
      })
    )
    expect(r).toMatchObject({ executable: true, kind: 'pnpm-global' })
  })

  it('detects pnpm-global on a Windows-style path', async () => {
    const r = await detectInstallSource(
      ctx({
        argv1:
          'C:\\Users\\x\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@motrix\\cli\\dist\\bin\\motrix.js',
      })
    )
    expect(r).toMatchObject({ executable: true, kind: 'pnpm-global' })
  })

  it('detects yarn-global', async () => {
    const r = await detectInstallSource(
      ctx({
        argv1:
          '/Users/x/.yarn/global/node_modules/@motrix/cli/dist/bin/motrix.js',
      })
    )
    expect(r).toMatchObject({ executable: true, kind: 'yarn-global' })
  })

  it('detects yarn-global at Yarn Classic default (~/.config/yarn/global)', async () => {
    // Yarn Classic's DEFAULT global dir — not `~/.yarn/global`. Missing this
    // fragment misclassifies a normal yarn install as unknown, which then
    // wrongly recommends `npm i -g` and creates a shadowing copy.
    const run = vi.fn()
    const r = await detectInstallSource(
      ctx({
        argv1:
          '/Users/x/.config/yarn/global/node_modules/@motrix/cli/dist/bin/motrix.js',
        runCommand: run,
      })
    )
    expect(r).toMatchObject({ executable: true, kind: 'yarn-global' })
    // Matched by fragment before the npm probe — no subprocess spawned.
    expect(run).not.toHaveBeenCalled()
  })

  it('detects bun-global (install/global, not install/cache)', async () => {
    const r = await detectInstallSource(
      ctx({
        argv1:
          '/Users/x/.bun/install/global/node_modules/@motrix/cli/dist/bin/motrix.js',
      })
    )
    expect(r).toMatchObject({ executable: true, kind: 'bun-global' })
  })

  it('detects npm-global by realpathing the bin into npm root -g', async () => {
    // argv1 is the PATH symlink; realpath resolves it into the global tree.
    const realpath = vi
      .fn()
      .mockImplementation(async (p: string) =>
        p === '/usr/local/bin/motrix'
          ? `${NPM_ROOT}/@motrix/cli/dist/bin/motrix.js`
          : p
      )
    const runCommand = vi
      .fn()
      .mockResolvedValue({ code: 0, stdout: `${NPM_ROOT}\n`, stderr: '' })
    const r = await detectInstallSource(
      ctx({ argv1: '/usr/local/bin/motrix', realpath, runCommand })
    )
    expect(r).toMatchObject({
      executable: true,
      kind: 'npm-global',
      globalRoot: NPM_ROOT,
    })
    // The probe runs from the neutral dir, not the CLI's cwd — a project-local
    // .npmrc must not be able to skew it.
    expect(runCommand).toHaveBeenCalledWith(
      'npm',
      ['root', '-g'],
      expect.objectContaining({ cwd: '/tmp' })
    )
  })
})

describe('installArgsFor', () => {
  it('maps every executable kind to its installer invocation', () => {
    const spec = '@motrix/cli@0.3.0'
    expect(installArgsFor('npm-global', spec)).toEqual([
      'npm',
      'install',
      '-g',
      spec,
    ])
    expect(installArgsFor('pnpm-global', spec)).toEqual([
      'pnpm',
      'add',
      '-g',
      spec,
    ])
    expect(installArgsFor('yarn-global', spec)).toEqual([
      'yarn',
      'global',
      'add',
      spec,
    ])
    expect(installArgsFor('bun-global', spec)).toEqual([
      'bun',
      'add',
      '-g',
      spec,
    ])
    expect(installArgsFor('volta', spec)).toEqual(['volta', 'install', spec])
  })
})
