# `motrix self-update` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `motrix self-update [target] [--dry-run]` command that updates the globally installed `@motrix/cli` by detecting which package manager installed it and delegating the reinstall to that manager — plus the missing `motrix --version` it depends on.

**Architecture:** Five small new modules with injectable side effects, mirroring the `open.ts` result-object pattern: `pkg.ts` (own version), `run-command.ts` (buffered spawn), `semver.ts` (minimal compare), `install-source.ts` (detection cascade), `registry.ts` (resolve-before-install), composed by `commands/self-update.ts`. The command never mutates on an uncertain detection — it refuses and prints the manual command.

**Tech Stack:** TypeScript (ESM, Node ≥ 20), commander ^12, vitest, tsup single-file bundle, Biome.

**Spec:** `docs/superpowers/specs/2026-07-16-motrix-self-update-design.md` (approved; bilingual twin `.zh-CN.md`).

## Global Constraints

- Node `>=20`, `"type": "module"` — ESM imports with `node:` prefixes.
- **No new runtime dependencies** — `dependencies` stays `{ "commander": "^12" }`.
- Biome style (run `pnpm lint` before every commit): no semicolons, single quotes, 2-space indent, `import type` for type-only imports.
- Exit-code contract is a public surface: `0 ok / 2 usage / 3 network / 4 auth / 5 server / 6 not-installed`; this change adds exactly one code, `SELF_UPDATE_FAILED: 7`.
- Unit tests only: no real network, no real global installs, no wall-clock — every side effect is injected (pattern: `src/commands/open.test.ts`'s `deps()` factory). Real `spawn`/`fs` are exercised only where the module under test IS the wrapper (`run-command.test.ts`, `pkg.test.ts` temp dirs).
- Refuse-when-uncertain: any ambiguous install source must never trigger an install.
- Docs are bilingual — every README.md edit has a README.zh-CN.md twin.
- Conventional Commits in English; never add `Co-Authored-By` or AI attribution lines.
- Working dir for all commands: `/Users/xanaduv/Work/code/motrix-app/cli`.

---

### Task 1: Own-version resolution + `motrix --version`

**Files:**
- Create: `src/pkg.ts`
- Create: `src/pkg.test.ts`
- Modify: `src/program.ts` (root command chain at :62-73; `pair` action at :126-137)

**Interfaces:**
- Consumes: nothing new.
- Produces: `readOwnVersion(startDir?: string): string | null` from `src/pkg.ts` — Task 5's ctx and Task 6's registration use it.

- [ ] **Step 1: Write the failing test**

```ts
// src/pkg.test.ts
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readOwnVersion } from './pkg'

/** A throwaway dir tree: package.json at the root, start dir `depth` below. */
function makePkgTree(
  pkgJson: unknown,
  depth: string[]
): { root: string; start: string } {
  const root = mkdtempSync(join(tmpdir(), 'motrix-pkg-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkgJson))
  const start = join(root, ...depth)
  mkdirSync(start, { recursive: true })
  return { root, start }
}

describe('readOwnVersion', () => {
  it('finds the version from a dist-style depth (dist/bin)', () => {
    const { start } = makePkgTree(
      { name: '@motrix/cli', version: '9.9.9' },
      ['dist', 'bin']
    )
    expect(readOwnVersion(start)).toBe('9.9.9')
  })

  it('finds the version from a src-style depth (src/commands)', () => {
    const { start } = makePkgTree(
      { name: '@motrix/cli', version: '1.2.3' },
      ['src', 'commands']
    )
    expect(readOwnVersion(start)).toBe('1.2.3')
  })

  it('skips package.json files belonging to other packages', () => {
    const { root, start } = makePkgTree(
      { name: '@motrix/cli', version: '2.0.0' },
      ['node_modules', 'other', 'dist']
    )
    writeFileSync(
      join(root, 'node_modules', 'other', 'package.json'),
      JSON.stringify({ name: 'other', version: '0.0.1' })
    )
    expect(readOwnVersion(start)).toBe('2.0.0')
  })

  it('returns null when nothing matches within the walk bound', () => {
    const root = mkdtempSync(join(tmpdir(), 'motrix-pkg-'))
    const start = join(root, 'a', 'b')
    mkdirSync(start, { recursive: true })
    expect(readOwnVersion(start)).toBe(null)
  })

  it('resolves this repo’s own version with no argument', () => {
    const expected = (
      JSON.parse(
        readFileSync(join(process.cwd(), 'package.json'), 'utf-8')
      ) as { version: string }
    ).version
    expect(readOwnVersion()).toBe(expected)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/pkg.test.ts`
Expected: FAIL — cannot resolve `./pkg`.

- [ ] **Step 3: Write the implementation**

```ts
// src/pkg.ts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OWN_NAME = '@motrix/cli'
const MAX_WALK = 5

/**
 * This package's own version, found by walking upward from the module
 * location to the nearest package.json named `@motrix/cli`. Depth-independent
 * on purpose: the dev entry runs from `src/**` and the bundle from
 * `dist/bin/motrix.js`, both inside the package root, where `package.json`
 * ships via `files` (tsup does not inline it). Returns null when no own
 * package.json is found — an install too broken to describe itself.
 */
export function readOwnVersion(startDir?: string): string | null {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < MAX_WALK; i++) {
    try {
      const raw = readFileSync(join(dir, 'package.json'), 'utf-8')
      const pkg = JSON.parse(raw) as { name?: string; version?: string }
      if (pkg.name === OWN_NAME && typeof pkg.version === 'string') {
        return pkg.version
      }
    } catch {
      // not here (or unreadable) — keep walking up
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/pkg.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire `--version` and `pair`'s `clientVersion` in `src/program.ts`**

Add the import (alphabetical among local imports, after `./output`):

```ts
import { readOwnVersion } from './pkg'
```

In `buildProgram()`, extend the root chain (currently `.name(...).description(...).option(...)` at src/program.ts:62-73) with a `.version(...)` call directly after `.description(...)`:

```ts
    .description('Drive a local or remote Motrix download manager.')
    .version(readOwnVersion() ?? 'unknown', '-V, --version', 'print the CLI version')
```

(Under `applyExitOverride`, commander prints the version then throws a `CommanderError` with `exitCode 0`, which `runMain` already maps to `EXIT.OK` — no other change needed.)

In the `pair` action (src/program.ts:131-137), add `clientVersion` to the context object passed to `runPair`:

```ts
      await runPair(opts, {
        baseUrl,
        stdout: process.stdout,
        stderr: process.stderr,
        json: global.json,
        clientVersion: readOwnVersion() ?? undefined,
      })
```

- [ ] **Step 6: Verify the whole suite, typecheck, and a real smoke run**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass, no Biome diagnostics.

Run: `pnpm build && node dist/bin/motrix.js --version`
Expected: prints the current `package.json` version (`0.2.1`), exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/pkg.ts src/pkg.test.ts src/program.ts
git commit -m "feat(version): add motrix --version backed by own-package resolution"
```

---

### Task 2: Buffered command runner + minimal semver compare

**Files:**
- Create: `src/run-command.ts`
- Create: `src/run-command.test.ts`
- Create: `src/semver.ts`
- Create: `src/semver.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `interface RunResult { code: number | null; stdout: string; stderr: string; spawnError?: NodeJS.ErrnoException }`
  - `type RunCommand = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<RunResult>` and the default `runCommand` impl — Tasks 3-5 inject this type everywhere.
  - `compareSemver(a: string, b: string): -1 | 0 | 1` and `pickHighest(versions: string[]): string | null` — Tasks 4-5.

- [ ] **Step 1: Write the failing runner test**

```ts
// src/run-command.test.ts
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
```

(The spawn-failure expectation holds on POSIX, where dev/CI run; on win32 the shell wrapper would absorb it — acceptable, noted in the module comment.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/run-command.test.ts`
Expected: FAIL — cannot resolve `./run-command`.

- [ ] **Step 3: Implement the runner**

```ts
// src/run-command.ts
import { spawn } from 'node:child_process'

export interface RunResult {
  /** Exit code; null when the binary could not be spawned (e.g. ENOENT). */
  code: number | null
  stdout: string
  stderr: string
  spawnError?: NodeJS.ErrnoException
}

export type RunCommand = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string }
) => Promise<RunResult>

/**
 * Buffered, non-interactive command runner. stdin is ignored and output is
 * captured, not streamed: npm can prompt mid-install, and a hidden prompt on
 * piped stdio reads as a hang — captured output is printed only on failure.
 * On win32 the package-manager entry points are `.cmd` shims, which Node
 * refuses to spawn without a shell (EINVAL, CVE-2024-27980), so a shell is
 * used there; callers must pass only validated arguments (see SPEC_RE in
 * commands/self-update.ts). A shell also means spawn failures surface as a
 * non-zero exit instead of `code: null` on win32.
 */
export const runCommand: RunCommand = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (spawnError: NodeJS.ErrnoException) => {
      resolve({ code: null, stdout, stderr, spawnError })
    })
    // 'close' (not 'exit') so the stdio streams are fully flushed first.
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run src/run-command.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing semver test**

```ts
// src/semver.test.ts
import { describe, expect, it } from 'vitest'
import { compareSemver, pickHighest } from './semver'

describe('compareSemver', () => {
  it('orders by major/minor/patch numerically', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1)
    expect(compareSemver('0.10.0', '0.9.9')).toBe(1)
    expect(compareSemver('0.2.1', '0.2.1')).toBe(0)
  })

  it('sorts a prerelease before its release', () => {
    expect(compareSemver('1.0.0-beta.1', '1.0.0')).toBe(-1)
    expect(compareSemver('1.0.0', '1.0.0-rc.0')).toBe(1)
  })

  it('compares prerelease identifiers per SemVer §11', () => {
    expect(compareSemver('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1) // numeric
    expect(compareSemver('1.0.0-alpha', '1.0.0-beta')).toBe(-1) // lexical
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1) // shorter set
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1) // numeric < alpha
  })
})

describe('pickHighest', () => {
  it('picks the highest of a range result', () => {
    expect(pickHighest(['0.1.0', '0.2.1', '0.2.0'])).toBe('0.2.1')
  })

  it('returns null for an empty list', () => {
    expect(pickHighest([])).toBe(null)
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm vitest run src/semver.test.ts`
Expected: FAIL — cannot resolve `./semver`.

- [ ] **Step 7: Implement the compare**

```ts
// src/semver.ts
/**
 * Minimal semver ordering for the self-update guards — `x.y.z` plus an
 * optional prerelease (`-alpha.1`): a prerelease sorts before its release,
 * identifiers compare segment-wise (numeric when both numeric, SemVer §11).
 * Build metadata (`+…`) is not handled — npm never serves two published
 * versions differing only by build metadata. Not a range evaluator: range
 * SPECS are resolved by `npm view`; this only orders concrete versions.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  const as = pa.pre.split('.')
  const bs = pb.pre.split('.')
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i]
    const y = bs[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const dx = Number(x)
      const dy = Number(y)
      if (dx !== dy) return dx < dy ? -1 : 1
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** Highest version under compareSemver; null for an empty list. */
export function pickHighest(versions: string[]): string | null {
  let best: string | null = null
  for (const v of versions) {
    if (best === null || compareSemver(v, best) > 0) best = v
  }
  return best
}

function parse(v: string): {
  nums: [number, number, number]
  pre: string | null
} {
  const dash = v.indexOf('-')
  const core = dash === -1 ? v : v.slice(0, dash)
  const pre = dash === -1 ? null : v.slice(dash + 1)
  const segs = core.split('.').map((n) => {
    const x = Number.parseInt(n, 10)
    return Number.isNaN(x) ? 0 : x
  })
  return { nums: [segs[0] ?? 0, segs[1] ?? 0, segs[2] ?? 0], pre }
}
```

- [ ] **Step 8: Run all new tests + repo gates**

Run: `pnpm vitest run src/semver.test.ts src/run-command.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS, no diagnostics.

- [ ] **Step 9: Commit**

```bash
git add src/run-command.ts src/run-command.test.ts src/semver.ts src/semver.test.ts
git commit -m "feat(self-update): add buffered command runner and minimal semver compare"
```

---

### Task 3: Install-source detection cascade

**Files:**
- Create: `src/install-source.ts`
- Create: `src/install-source.test.ts`

**Interfaces:**
- Consumes: `RunCommand`, `RunResult` from `src/run-command.ts` (Task 2).
- Produces (Task 5 consumes all of these):
  - `OWN_PACKAGE = '@motrix/cli'`
  - `type ExecutableKind = 'npm-global' | 'pnpm-global' | 'yarn-global' | 'bun-global' | 'volta'`
  - `type RefusedKind = 'npx' | 'pnpm-dlx' | 'bunx' | 'checkout' | 'unknown'`
  - `type InstallSource = { executable: true; kind: ExecutableKind; globalRoot?: string } | { executable: false; kind: RefusedKind; reason: string; manualCommand: string }`
  - `interface DetectCtx { argv1: string; realpath: (p: string) => Promise<string>; env: NodeJS.ProcessEnv; runCommand: RunCommand }`
  - `detectInstallSource(ctx: DetectCtx): Promise<InstallSource>`
  - `installArgsFor(kind: ExecutableKind, packageSpec: string): string[]`

- [ ] **Step 1: Write the failing test**

```ts
// src/install-source.test.ts
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
    const r = await detectInstallSource(
      ctx({ argv1: '/usr/local/bin/motrix', realpath })
    )
    expect(r).toMatchObject({
      executable: true,
      kind: 'npm-global',
      globalRoot: NPM_ROOT,
    })
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
    expect(installArgsFor('bun-global', spec)).toEqual(['bun', 'add', '-g', spec])
    expect(installArgsFor('volta', spec)).toEqual(['volta', 'install', spec])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/install-source.test.ts`
Expected: FAIL — cannot resolve `./install-source`.

- [ ] **Step 3: Implement the cascade**

```ts
// src/install-source.ts
import type { RunCommand } from './run-command'

/** The npm package this CLI ships as — what a self-update reinstalls. */
export const OWN_PACKAGE = '@motrix/cli'

export type ExecutableKind =
  | 'npm-global'
  | 'pnpm-global'
  | 'yarn-global'
  | 'bun-global'
  | 'volta'

export type RefusedKind = 'npx' | 'pnpm-dlx' | 'bunx' | 'checkout' | 'unknown'

export type InstallSource =
  | { executable: true; kind: ExecutableKind; globalRoot?: string }
  | { executable: false; kind: RefusedKind; reason: string; manualCommand: string }

export interface DetectCtx {
  /** process.argv[1] — the bin path the CLI was started from. */
  argv1: string
  realpath: (p: string) => Promise<string>
  env: NodeJS.ProcessEnv
  /** Used only by the final `npm root -g` probe. */
  runCommand: RunCommand
}

/** The exact installer invocation, e.g. `['pnpm','add','-g','@motrix/cli@1.2.3']`. */
export function installArgsFor(
  kind: ExecutableKind,
  packageSpec: string
): string[] {
  switch (kind) {
    case 'volta':
      return ['volta', 'install', packageSpec]
    case 'pnpm-global':
      return ['pnpm', 'add', '-g', packageSpec]
    case 'yarn-global':
      return ['yarn', 'global', 'add', packageSpec]
    case 'bun-global':
      return ['bun', 'add', '-g', packageSpec]
    case 'npm-global':
      return ['npm', 'install', '-g', packageSpec]
  }
}

const NPM_MANUAL = `npm install -g ${OWN_PACKAGE}@latest`

/**
 * Classify how this CLI was installed from the realpath of its bin. Cheap
 * synchronous path-fragment checks run first; the one subprocess probe
 * (`npm root -g`) runs last. Anything unrecognized is REFUSED — updating via
 * the wrong manager installs a second, PATH-shadowing copy, which is worse
 * than asking the user to run one command by hand (the pnpm corepack-guard
 * principle; the accident class this avoids is claude-code#28625).
 */
export async function detectInstallSource(
  ctx: DetectCtx
): Promise<InstallSource> {
  let real = ctx.argv1
  try {
    real = await ctx.realpath(ctx.argv1)
  } catch {
    // keep the unresolved path — the cascade still classifies most layouts
  }
  const p = real.replaceAll('\\', '/')

  // npm's npx cache dir is always literally `_npx` (~/.npm/_npx on POSIX,
  // %LocalAppData%/npm-cache/_npx on Windows).
  if (p.includes('/_npx/')) {
    return refused('npx', 'running via npx — a one-off copy, nothing to update')
  }
  if (p.includes('/.pnpm/_pnpx/') || p.includes('/.cache/pnpm/dlx/')) {
    return refused(
      'pnpm-dlx',
      'running via pnpm dlx — a one-off copy, nothing to update'
    )
  }
  if (p.includes('/.bun/install/cache/')) {
    return refused('bunx', 'running via bunx — a one-off copy, nothing to update')
  }
  if (!p.includes('/node_modules/')) {
    return {
      executable: false,
      kind: 'checkout',
      reason: 'running from a source checkout, not an installed package',
      manualCommand: 'git pull && pnpm install && pnpm build',
    }
  }
  if (p.includes('/.volta/') || p.includes('/Volta/')) {
    return { executable: true, kind: 'volta' }
  }
  const pnpmHome = ctx.env.PNPM_HOME?.replaceAll('\\', '/')
  if (
    (pnpmHome && p.startsWith(withSlash(pnpmHome))) ||
    p.includes('/.local/share/pnpm/') ||
    p.includes('/Library/pnpm/') ||
    p.includes('/AppData/Local/pnpm/') ||
    p.includes('/.pnpm/global/')
  ) {
    return { executable: true, kind: 'pnpm-global' }
  }
  if (p.includes('/.yarn/global/')) {
    return { executable: true, kind: 'yarn-global' }
  }
  if (p.includes('/.bun/install/global/')) {
    return { executable: true, kind: 'bun-global' }
  }
  const root = await npmGlobalRoot(ctx)
  if (root && p.startsWith(withSlash(root.replaceAll('\\', '/')))) {
    return { executable: true, kind: 'npm-global', globalRoot: root }
  }
  return refused('unknown', 'could not determine how this CLI was installed')
}

function refused(kind: RefusedKind, reason: string): InstallSource {
  return { executable: false, kind, reason, manualCommand: NPM_MANUAL }
}

function withSlash(dir: string): string {
  return dir.endsWith('/') ? dir : `${dir}/`
}

/** `npm root -g`, realpath'd; null when npm is unusable or silent. */
async function npmGlobalRoot(ctx: DetectCtx): Promise<string | null> {
  const res = await ctx.runCommand('npm', ['root', '-g'])
  if (res.code !== 0) return null
  const raw = res.stdout.trim()
  if (!raw) return null
  try {
    return await ctx.realpath(raw)
  } catch {
    return raw
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run src/install-source.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Repo gates and commit**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass.

```bash
git add src/install-source.ts src/install-source.test.ts
git commit -m "feat(self-update): detect how the CLI was installed, refusing when uncertain"
```

---

### Task 4: Registry version resolution (`npm view`, resolve-before-install)

**Files:**
- Create: `src/registry.ts`
- Create: `src/registry.test.ts`

**Interfaces:**
- Consumes: `RunCommand` (Task 2), `pickHighest` (Task 2), `OWN_PACKAGE` (Task 3).
- Produces (Task 5 consumes):
  - `type ResolveOutcome = { ok: true; version: string } | { ok: false; reason: 'bad-target' | 'resolve-failed'; message: string }`
  - `interface ResolveCtx { runCommand: RunCommand; tmpdir: string; allowPnpmFallback: boolean }`
  - `resolveTargetVersion(spec: string, ctx: ResolveCtx): Promise<ResolveOutcome>`

- [ ] **Step 1: Write the failing test**

```ts
// src/registry.test.ts
import { describe, expect, it, vi } from 'vitest'
import type { RunResult } from './run-command'
import { type ResolveCtx, resolveTargetVersion } from './registry'

function ctx(result: Partial<RunResult>, over: Partial<ResolveCtx> = {}): ResolveCtx {
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/registry.test.ts`
Expected: FAIL — cannot resolve `./registry`.

- [ ] **Step 3: Implement resolution**

```ts
// src/registry.ts
import { OWN_PACKAGE } from './install-source'
import type { RunCommand } from './run-command'
import { pickHighest } from './semver'

export type ResolveOutcome =
  | { ok: true; version: string }
  | { ok: false; reason: 'bad-target' | 'resolve-failed'; message: string }

export interface ResolveCtx {
  runCommand: RunCommand
  /** cwd for the view subprocess — a neutral dir, so the surrounding
   *  project's .npmrc / lockfile can't capture a global operation. */
  tmpdir: string
  /** Try `pnpm view` when npm itself is missing (pnpm-only machines). */
  allowPnpmFallback: boolean
}

/**
 * Resolve a user spec (version / range / dist-tag) to ONE concrete published
 * version BEFORE installing — so the reported and installed versions can't
 * drift apart between check and install, and the post-install verification
 * has an exact expectation. Spawning `view` (instead of a bare registry
 * fetch) keeps resolution consistent with whatever registry/auth config the
 * installer itself would use.
 */
export async function resolveTargetVersion(
  spec: string,
  ctx: ResolveCtx
): Promise<ResolveOutcome> {
  const args = ['view', `${OWN_PACKAGE}@${spec}`, 'version', '--json']
  let res = await ctx.runCommand('npm', args, { cwd: ctx.tmpdir })
  if (res.code === null && ctx.allowPnpmFallback) {
    res = await ctx.runCommand('pnpm', args, { cwd: ctx.tmpdir })
  }
  if (res.code === null) {
    return {
      ok: false,
      reason: 'resolve-failed',
      message:
        'npm is not available to query the registry — install npm or update manually',
    }
  }
  if (res.code !== 0) {
    if (res.stderr.includes('EINVALIDTAGNAME')) {
      return {
        ok: false,
        reason: 'bad-target',
        message: `invalid version spec "${spec}"`,
      }
    }
    if (res.stderr.includes('E404')) {
      return {
        ok: false,
        reason: 'resolve-failed',
        message: `${OWN_PACKAGE}@${spec} not found on the registry`,
      }
    }
    const firstLine = res.stderr.trim().split('\n')[0] ?? ''
    return {
      ok: false,
      reason: 'resolve-failed',
      message: `registry query failed: ${firstLine}`,
    }
  }
  const out = res.stdout.trim()
  if (!out) {
    // npm exits 0 with empty output for a RANGE that matches nothing.
    return {
      ok: false,
      reason: 'resolve-failed',
      message: `no published version matches "${spec}"`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(out)
  } catch {
    return {
      ok: false,
      reason: 'resolve-failed',
      message: 'unexpected npm view output',
    }
  }
  if (typeof parsed === 'string') return { ok: true, version: parsed }
  if (Array.isArray(parsed)) {
    const versions = parsed.filter((v): v is string => typeof v === 'string')
    const highest = pickHighest(versions)
    if (highest) return { ok: true, version: highest }
  }
  return {
    ok: false,
    reason: 'resolve-failed',
    message: 'unexpected npm view output',
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run src/registry.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Repo gates and commit**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass.

```bash
git add src/registry.ts src/registry.test.ts
git commit -m "feat(self-update): resolve the target version before installing"
```

---

### Task 5: The `runSelfUpdate` orchestrator + `EXIT.SELF_UPDATE_FAILED`

**Files:**
- Modify: `src/errors.ts:6-13` (the `EXIT` const and its doc comment)
- Create: `src/commands/self-update.ts`
- Create: `src/commands/self-update.test.ts`

**Interfaces:**
- Consumes: `readOwnVersion` (Task 1); `RunCommand`/`runCommand` (Task 2); `compareSemver` (Task 2); `detectInstallSource`, `installArgsFor`, `InstallSource`, `ExecutableKind`, `OWN_PACKAGE` (Task 3); `resolveTargetVersion` (Task 4).
- Produces (Task 6 consumes):
  - `interface SelfUpdateOpts { target?: string; dryRun?: boolean }`
  - `interface SelfUpdateResult { ok: boolean; exitCode: ExitCode; changed: boolean; reason?: SelfUpdateReason; dryRun?: boolean; from?: string; to?: string; method?: ExecutableKind; command?: string; manualCommand?: string; warning?: string; message: string }`
  - `runSelfUpdate(opts: SelfUpdateOpts, ctx: SelfUpdateCtx): Promise<SelfUpdateResult>`
  - `defaultSelfUpdateCtx(): SelfUpdateCtx`
  - `EXIT.SELF_UPDATE_FAILED = 7`

- [ ] **Step 1: Add the exit code (one-line contract change)**

In `src/errors.ts`, extend the `EXIT` const:

```ts
export const EXIT = {
  OK: 0,
  USAGE: 2,
  NETWORK: 3,
  AUTH: 4,
  SERVER: 5,
  NOT_INSTALLED: 6,
  SELF_UPDATE_FAILED: 7,
} as const
```

And extend the doc comment above it so the mirror list reads:
`0 ok · 2 usage · 3 network (bridge down) · 4 auth (401/403) · 5 server error · 6 not-installed (motrix open) · 7 self-update failed (motrix self-update)`.

- [ ] **Step 2: Write the failing test**

```ts
// src/commands/self-update.test.ts
import { describe, expect, it, vi } from 'vitest'
import { EXIT } from '../errors'
import type { RunResult } from '../run-command'
import {
  runSelfUpdate,
  type SelfUpdateCtx,
} from './self-update'

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
      argv1: '/Users/x/.npm/_npx/1a2b/node_modules/@motrix/cli/dist/bin/motrix.js',
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
      ctx({ runCommand: scriptedRun({ view: { code: 0, stdout: '"0.2.1"\n', stderr: '' } }) })
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
      argv1: '/Users/x/.yarn/global/node_modules/@motrix/cli/dist/bin/motrix.js',
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
      argv1: '/Users/x/.volta/tools/image/node_modules/@motrix/cli/dist/bin/motrix.js',
      whichBin: async () => null,
    })
    const r = await runSelfUpdate({}, c)
    expect(r).toMatchObject({ ok: true, changed: true, method: 'volta' })
    expect(r.warning).toBeDefined()
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run src/commands/self-update.test.ts`
Expected: FAIL — cannot resolve `./self-update`.

- [ ] **Step 4: Implement the orchestrator**

```ts
// src/commands/self-update.ts
import { access, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { EXIT, type ExitCode } from '../errors'
import {
  detectInstallSource,
  type ExecutableKind,
  type InstallSource,
  installArgsFor,
  OWN_PACKAGE,
} from '../install-source'
import { readOwnVersion } from '../pkg'
import { resolveTargetVersion } from '../registry'
import { type RunCommand, runCommand } from '../run-command'
import { compareSemver } from '../semver'

export interface SelfUpdateOpts {
  /** Positional [target] — version / range / dist-tag. Default `latest`. */
  target?: string
  dryRun?: boolean
}

export type SelfUpdateReason =
  | 'bad-target'
  | 'resolve-failed'
  | 'already-up-to-date'
  | 'downgrade-refused'
  | 'unsupported-ephemeral'
  | 'unsupported-checkout'
  | 'unknown-install'
  | 'install-failed'
  | 'verify-failed'

export interface SelfUpdateResult {
  ok: boolean
  exitCode: ExitCode
  /** True only when a new version was actually installed. */
  changed: boolean
  reason?: SelfUpdateReason
  dryRun?: boolean
  from?: string
  to?: string
  /** Which installer ran (or would run). */
  method?: ExecutableKind
  /** The exact installer command (ran, or would run for --dry-run). */
  command?: string
  manualCommand?: string
  warning?: string
  message: string
}

export interface SelfUpdateCtx {
  /** null when the install is too broken to read its own package.json. */
  currentVersion: string | null
  argv1: string
  env: NodeJS.ProcessEnv
  realpath: (p: string) => Promise<string>
  runCommand: RunCommand
  tmpdir: string
  /** Resolve a bin name on PATH; null when absent (shadowing check). */
  whichBin: (name: string) => Promise<string | null>
}

/** Conservative spec charset: versions, dist-tags, `^`/`~`/`.x` ranges.
 *  Shell metacharacters (spaces, `>` `<` `|` `&` `;` …) are rejected because
 *  the installer legitimately runs through a shell on Windows. */
const SPEC_RE = /^[A-Za-z0-9._^~*+-]+$/

const NPM_MANUAL = `npm install -g ${OWN_PACKAGE}@latest`

/**
 * `motrix self-update [target]` — pnpm's self-update UX translated to an
 * npm-distributed CLI: detect who installed us, resolve the target to one
 * concrete version, guard no-ops and implicit downgrades, then DELEGATE the
 * install to the owning package manager (never mutate its tree ourselves).
 * Every failure path leaves the current install untouched and ends with a
 * copy-pasteable manual command.
 */
export async function runSelfUpdate(
  opts: SelfUpdateOpts,
  ctx: SelfUpdateCtx
): Promise<SelfUpdateResult> {
  const spec = opts.target ?? 'latest'
  const implicitLatest = opts.target === undefined

  if (!SPEC_RE.test(spec)) {
    return {
      ok: false,
      exitCode: EXIT.USAGE,
      changed: false,
      reason: 'bad-target',
      message: `invalid version spec "${spec}" — use a version (0.2.1), range (^0.2.0), or dist-tag (latest)`,
    }
  }
  if (!ctx.currentVersion) {
    return {
      ok: false,
      exitCode: EXIT.SELF_UPDATE_FAILED,
      changed: false,
      reason: 'unknown-install',
      manualCommand: NPM_MANUAL,
      message: `cannot determine the installed version. You can reinstall manually: ${NPM_MANUAL}`,
    }
  }

  const source = await detectInstallSource({
    argv1: ctx.argv1,
    realpath: ctx.realpath,
    env: ctx.env,
    runCommand: ctx.runCommand,
  })
  if (!source.executable) {
    const reason: SelfUpdateReason =
      source.kind === 'checkout'
        ? 'unsupported-checkout'
        : source.kind === 'unknown'
          ? 'unknown-install'
          : 'unsupported-ephemeral'
    return {
      ok: false,
      exitCode: EXIT.SELF_UPDATE_FAILED,
      changed: false,
      reason,
      manualCommand: source.manualCommand,
      message: `${source.reason}. You can run it manually: ${source.manualCommand}`,
    }
  }

  const resolved = await resolveTargetVersion(spec, {
    runCommand: ctx.runCommand,
    tmpdir: ctx.tmpdir,
    allowPnpmFallback: source.kind === 'pnpm-global',
  })
  if (!resolved.ok) {
    return {
      ok: false,
      exitCode: resolved.reason === 'bad-target' ? EXIT.USAGE : EXIT.NETWORK,
      changed: false,
      reason: resolved.reason,
      message: resolved.message,
    }
  }

  const from = ctx.currentVersion
  const to = resolved.version
  const cmp = compareSemver(to, from)
  if (cmp === 0) {
    return {
      ok: true,
      exitCode: EXIT.OK,
      changed: false,
      reason: 'already-up-to-date',
      from,
      to,
      message: `Already up to date (${from})`,
    }
  }
  if (implicitLatest && cmp < 0) {
    return {
      ok: true,
      exitCode: EXIT.OK,
      changed: false,
      reason: 'downgrade-refused',
      from,
      to,
      message:
        `Installed ${from} is newer than latest on the registry (${to}); nothing to do. ` +
        `Run \`motrix self-update ${to}\` to downgrade explicitly.`,
    }
  }

  const installArgs = installArgsFor(source.kind, `${OWN_PACKAGE}@${to}`)
  const command = installArgs.join(' ')
  if (opts.dryRun) {
    return {
      ok: true,
      exitCode: EXIT.OK,
      changed: false,
      dryRun: true,
      from,
      to,
      method: source.kind,
      command,
      message: `Would run: ${command} (${from} → ${to})`,
    }
  }

  const inst = await ctx.runCommand(installArgs[0], installArgs.slice(1), {
    cwd: ctx.tmpdir,
  })
  if (inst.code !== 0) {
    const output = `${inst.stdout}${inst.stderr}`.trim()
    const eaccesHint = /EACCES|EPERM/.test(inst.stderr)
      ? '\nPermission denied on the global directory. Do NOT use sudo — fix the npm prefix instead: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally'
      : ''
    const exitDesc =
      inst.code === null
        ? `spawn error (${inst.spawnError?.code ?? 'unknown'})`
        : `exit ${inst.code}`
    return {
      ok: false,
      exitCode: EXIT.SELF_UPDATE_FAILED,
      changed: false,
      reason: 'install-failed',
      from,
      to,
      method: source.kind,
      manualCommand: command,
      message:
        `installer failed (${exitDesc})${output ? `:\n${output}` : ''}${eaccesHint}` +
        `\nYou can run it manually: ${command}`,
    }
  }

  const verified = await verifyInstall(source, to, ctx)
  if (!verified.ok) {
    return {
      ok: false,
      exitCode: EXIT.SELF_UPDATE_FAILED,
      changed: false,
      reason: 'verify-failed',
      from,
      to,
      method: source.kind,
      manualCommand: command,
      message: `${verified.detail}. You can run it manually: ${command}`,
    }
  }

  return {
    ok: true,
    exitCode: EXIT.OK,
    changed: true,
    from,
    to,
    method: source.kind,
    command,
    warning: verified.warning,
    message:
      `Updated ${OWN_PACKAGE} ${from} → ${to} (${source.kind})` +
      (verified.warning ? `\nwarning: ${verified.warning}` : ''),
  }
}

interface VerifyOutcome {
  ok: boolean
  warning?: string
  detail?: string
}

/**
 * npm/pnpm can report their global root, so the fresh entry file is invoked
 * directly (PATH-independent) and must report the exact target version. For
 * yarn/bun/volta — and when the root query itself breaks (pnpm/pnpm#11528) —
 * fall back to a PATH check that only ever WARNS: the installer already
 * reported success, and a mismatch there usually means another install
 * shadows the updated one.
 */
async function verifyInstall(
  source: InstallSource & { executable: true },
  expected: string,
  ctx: SelfUpdateCtx
): Promise<VerifyOutcome> {
  if (source.kind === 'npm-global' || source.kind === 'pnpm-global') {
    const pm = source.kind === 'npm-global' ? 'npm' : 'pnpm'
    let root = source.globalRoot ?? null
    if (!root) {
      const res = await ctx.runCommand(pm, ['root', '-g'], { cwd: ctx.tmpdir })
      root = res.code === 0 ? res.stdout.trim() || null : null
    }
    if (root) {
      const entry = join(root, '@motrix', 'cli', 'dist', 'bin', 'motrix.js')
      const res = await ctx.runCommand('node', [entry, '--version'], {
        cwd: ctx.tmpdir,
      })
      if (res.code === 0) {
        const got = res.stdout.trim()
        if (got === expected) return { ok: true }
        return {
          ok: false,
          detail: `installed entry reports ${got || '(nothing)'}, expected ${expected}`,
        }
      }
      return { ok: false, detail: `installed entry did not run (${entry})` }
    }
    // root query failed — degrade to the warning-only PATH check
  }
  const bin = await ctx.whichBin('motrix')
  if (!bin) {
    return {
      ok: true,
      warning:
        'could not find `motrix` on PATH to verify — open a new shell and check `motrix --version`',
    }
  }
  const res = await ctx.runCommand(bin, ['--version'], { cwd: ctx.tmpdir })
  const got = res.code === 0 ? res.stdout.trim() : null
  if (got === expected) return { ok: true }
  return {
    ok: true,
    warning: `\`motrix\` on PATH (${bin}) reports ${got ?? 'an error'}, not ${expected} — another install may be shadowing the updated one`,
  }
}

/** Minimal cross-platform `which`: the first PATH entry holding an existing
 *  `motrix` (with a PATHEXT extension on win32). Existence is enough — this
 *  feeds a warning-level check, not an execution decision. */
export async function defaultWhichBin(name: string): Promise<string | null> {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
      : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext.toLowerCase()}`)
      try {
        await access(candidate)
        return candidate
      } catch {
        // keep looking
      }
    }
  }
  return null
}

export function defaultSelfUpdateCtx(): SelfUpdateCtx {
  return {
    currentVersion: readOwnVersion(),
    argv1: process.argv[1] ?? '',
    env: process.env,
    realpath: (p) => realpath(p),
    runCommand,
    tmpdir: tmpdir(),
    whichBin: defaultWhichBin,
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm vitest run src/commands/self-update.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 6: Repo gates and commit**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass.

```bash
git add src/errors.ts src/commands/self-update.ts src/commands/self-update.test.ts
git commit -m "feat(self-update): add runSelfUpdate orchestrator and exit code 7"
```

---

### Task 6: Register the command, document it, bump to 0.3.0

**Files:**
- Modify: `src/program.ts` (imports at :1-19; add the command after the `open` block at :95-120)
- Modify: `README.md:45-59` (command table), `README.md:61-62` (global-flags line), `README.md:94-101` (exit-code table)
- Modify: `README.zh-CN.md` (the mirror rows of the same three spots)
- Modify: `SKILL.md:28-30` (exit-code list), `SKILL.md:35-47` (command list)
- Modify: `package.json:3` (version bump)

**Interfaces:**
- Consumes: `runSelfUpdate`, `defaultSelfUpdateCtx`, `SelfUpdateOpts` (Task 5); `wantsJson` from `src/output.ts` (existing).
- Produces: the user-facing `motrix self-update` command.

- [ ] **Step 1: Register the command in `src/program.ts`**

Add to the imports:

```ts
import { defaultSelfUpdateCtx, runSelfUpdate } from './commands/self-update'
```

Insert after the `open` command block (after src/program.ts:120), mirroring `open`'s print-and-exitCode handler:

```ts
  program
    .command('self-update')
    .description(
      'Update this CLI to the latest (or a given) published version.'
    )
    .argument('[target]', 'version, range, or dist-tag (default: latest)')
    .option('--dry-run', 'show what would run without changing anything')
    .action(async (target: string | undefined, opts: { dryRun?: boolean }) => {
      // Like `open`, self-update needs no bridge — never touches ioFromGlobals.
      const global = program.opts<GlobalOpts>()
      const result = await runSelfUpdate(
        { target, dryRun: opts.dryRun },
        defaultSelfUpdateCtx()
      )
      if (wantsJson({ json: global.json }, process.stdout)) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      } else if (result.ok) {
        process.stdout.write(`${result.message}\n`)
      } else {
        process.stderr.write(`motrix: ${result.message}\n`)
      }
      process.exitCode = result.exitCode
    })
```

- [ ] **Step 2: Verify the wiring end-to-end from the checkout**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: all pass.

Run: `node dist/bin/motrix.js self-update --dry-run; echo "exit=$?"`
Expected: stderr message containing `source checkout` and `git pull && pnpm install && pnpm build`; prints `exit=7`. (The checkout refusal fires before `--dry-run` matters — correct per spec.)

Run: `node dist/bin/motrix.js self-update --json | node -e "process.stdin.pipe(process.stdout)"; echo "exit=$?"`
Expected: a single JSON object with `"reason": "unsupported-checkout"`, `"ok": false`; `exit=7`.

- [ ] **Step 3: Update README.md**

In the command table (README.md:45-59), add after the `motrix skill` row:

```markdown
| `motrix self-update [target] [--dry-run]` | Update this CLI itself via the package manager that installed it |
```

Replace the global-flags paragraph (README.md:61-62) with:

```markdown
Every command also accepts the global flags `--endpoint <url>`, `--token
<token>`, and `--json`. `motrix --version` prints the CLI version.
```

In the exit-code table (README.md:94-101), add after the `6` row:

```markdown
| `7` | Self-update failed — unsupported install source, installer error, or verification mismatch (`motrix self-update`) |
```

- [ ] **Step 4: Update README.zh-CN.md (mirror rows)**

Locate the same three spots (command table, global-flags paragraph, exit-code table — README.zh-CN.md mirrors README.md's structure) and add:

Command table row:

```markdown
| `motrix self-update [target] [--dry-run]` | 通过安装它的包管理器更新 CLI 自身 |
```

Global-flags paragraph — append the sentence:

```markdown
`motrix --version` 打印 CLI 版本。
```

Exit-code table row:

```markdown
| `7` | self-update 失败——安装源不支持、安装器报错或安装后验证不匹配(`motrix self-update`) |
```

- [ ] **Step 5: Update SKILL.md**

In the exit-code list (SKILL.md:28-30), add after the `6` line:

```markdown
  - `7` self-update failed — this environment can't self-update (npx / checkout / unknown install source) or the installer failed; don't retry, run the printed manual command instead
```

In the command list (SKILL.md:35-47), add after the `motrix skill` line:

```markdown
motrix self-update [target] [--dry-run]                   # update this CLI itself (exit 7 = can't update here)
```

- [ ] **Step 6: Bump the version**

In `package.json:3`: `"version": "0.2.1"` → `"version": "0.3.0"` (new user-facing command + new exit code → semver minor, per spec).

Run: `pnpm build && node dist/bin/motrix.js --version`
Expected: `0.3.0`.

- [ ] **Step 7: Final gate**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass, no diagnostics.

- [ ] **Step 8: Commit (registration + docs separately)**

```bash
git add src/program.ts
git commit -m "feat(self-update): register motrix self-update"
git add README.md README.zh-CN.md SKILL.md package.json
git commit -m "docs(self-update): document self-update + exit code 7; bump to 0.3.0"
```

---

## Out of scope (per spec)

Passive update notifications, background auto-update, Homebrew/standalone channels, Motrix-app version negotiation. The `chore(release): v0.3.0` tag + `pnpm publish` follow the repo's normal manual release flow after review — not part of this plan.
