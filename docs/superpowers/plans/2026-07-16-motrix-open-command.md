# `motrix open` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `motrix open` command that launches the local desktop Motrix via the `motrix://` URL scheme and returns success once its bridge is ready.

**Architecture:** A pure orchestrator `runOpen(opts, deps)` that returns a structured `OpenResult` (never throws for expected outcomes); all IO — the URL opener, the bridge probe, sleep, and clock — is injected so unit tests use no real process, socket, filesystem, or wall-clock. `program.ts` renders the result (`--json` object or human line) and sets `process.exitCode`.

**Tech Stack:** TypeScript (ESM, `verbatimModuleSyntax`), commander, vitest, tsup, biome. Node ≥ 20.

## Global Constraints

- **Command is explicit-only** — no auto-launch, no `--launch` on other commands. `list`/`add`/etc. keep their fail-fast behavior.
- **Local-desktop only** — a remote `--endpoint` must be rejected (`EXIT.USAGE`).
- **Reuse the existing DI/testing style** — pure functions + injected side effects, like `rpcCall(fetchImpl)` and `resolveEndpoint(pidAlive)`.
- **`open` must NOT call `discoverEndpoint`/`ioFromGlobals`** (those throw `EXIT.NETWORK` when the bridge is down — the exact case `open` handles).
- **Exit codes** — extend the contract with exactly one new code: `NOT_INSTALLED = 6`. Existing: `OK 0`, `USAGE 2`, `NETWORK 3`, `AUTH 4`, `SERVER 5`.
- **`open` reports a structured result** (does not throw `CliError`) because its failure modes are expected statuses; the action sets `process.exitCode` from the result.
- **Messages verbatim** (copy exactly):
  - remote: `open only launches the local desktop app; a remote --endpoint cannot be launched`
  - not installed: `Motrix desktop app not found — install it from https://motrix.app, or use --endpoint for a remote server`
  - timeout: `` Motrix was launched but its bridge did not come up within Ns. Try --timeout <ms>; if Motrix isn't installed, get it at https://motrix.app `` (N = `Math.round(timeout/1000)`)
  - opener missing: `could not open a URL on this system — start Motrix manually`
- **Version** — bump to `0.2.0` (semver minor).
- **Biome** — single quotes, no semicolons (asNeeded), 2-space, 80 cols, `import type` for type-only imports. Run `pnpm lint` before each commit.

---

### Task 1: Platform opener (`src/launch.ts`)

**Files:**
- Create: `src/launch.ts`
- Test: `src/launch.test.ts`

**Interfaces:**
- Produces:
  - `interface Opener { cmd: string; args: string[] }`
  - `openerFor(platform: NodeJS.Platform): Opener`
  - `interface SpawnResult { code: number | null; spawnError?: NodeJS.ErrnoException }`
  - `type SpawnOpener = (opener: Opener, url: string) => Promise<SpawnResult>`
  - `spawnOpener: SpawnOpener` (default impl over `node:child_process`)

- [ ] **Step 1: Write the failing test**

`src/launch.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { openerFor } from './launch'

describe('openerFor', () => {
  it('uses `open` on macOS', () => {
    expect(openerFor('darwin')).toEqual({ cmd: 'open', args: [] })
  })

  it('uses `cmd /c start ""` on Windows', () => {
    expect(openerFor('win32')).toEqual({ cmd: 'cmd', args: ['/c', 'start', ''] })
  })

  it('uses `xdg-open` on Linux and other platforms', () => {
    expect(openerFor('linux')).toEqual({ cmd: 'xdg-open', args: [] })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/launch.test.ts`
Expected: FAIL — cannot find module `./launch` / `openerFor is not a function`.

- [ ] **Step 3: Write the implementation**

`src/launch.ts`:

```ts
import { spawn } from 'node:child_process'

/** A platform command that hands a URL to its registered scheme handler. */
export interface Opener {
  cmd: string
  args: string[]
}

/** The URL-opener for a platform. The scheme handler (the installed Motrix
 *  app, which registers `motrix://`) does the actual launch/focus. */
export function openerFor(platform: NodeJS.Platform): Opener {
  if (platform === 'darwin') return { cmd: 'open', args: [] }
  // `start` needs a first quoted arg (window title); '' keeps the URL as target.
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', ''] }
  return { cmd: 'xdg-open', args: [] }
}

export interface SpawnResult {
  /** Opener exit code; `null` when the opener binary could not be spawned. */
  code: number | null
  spawnError?: NodeJS.ErrnoException
}

export type SpawnOpener = (opener: Opener, url: string) => Promise<SpawnResult>

/** Default opener: run `<cmd> <args...> <url>` and resolve its exit code.
 *  A non-zero code means the scheme has no handler (app not installed);
 *  `code: null` + `spawnError` means the opener binary itself is missing. */
export const spawnOpener: SpawnOpener = (opener, url) =>
  new Promise((resolve) => {
    const child = spawn(opener.cmd, [...opener.args, url], { stdio: 'ignore' })
    child.on('error', (spawnError: NodeJS.ErrnoException) => {
      resolve({ code: null, spawnError })
    })
    child.on('exit', (code) => resolve({ code }))
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/launch.test.ts`
Expected: PASS (3 tests). `spawnOpener` is a thin IO wrapper exercised via injection in Task 3 and manual smoke — not unit-tested directly (same as the default `fetchImpl` in `client.test.ts`).

- [ ] **Step 5: Lint + commit**

```bash
pnpm lint
git add src/launch.ts src/launch.test.ts
git commit -m "feat(open): add platform URL opener (motrix:// launcher)"
```

---

### Task 2: `runOpen` orchestrator (`src/commands/open.ts`)

**Files:**
- Modify: `src/errors.ts` (add `NOT_INSTALLED: 6`)
- Modify: `src/discovery.ts` (export `isPidAlive`)
- Create: `src/commands/open.ts`
- Test: `src/commands/open.test.ts`

**Interfaces:**
- Consumes: `openerFor`, `type SpawnOpener` (Task 1); `EXIT`, `type ExitCode` (`src/errors.ts`); `endpointFilePath`, `isPidAlive`, `type EndpointFile` (`src/discovery.ts`); `wantsJson` (`src/output.ts`, used by Task 3).
- Produces:
  - `interface OpenOpts { timeout?: number; endpoint?: string }`
  - `interface OpenDeps { platform: NodeJS.Platform; spawnOpener: SpawnOpener; probeBridge: () => Promise<string | null>; sleep: (ms: number) => Promise<void>; now: () => number }`
  - `type OpenReason = 'remote_endpoint' | 'not_installed' | 'launch_timeout' | 'opener_missing'`
  - `interface OpenResult { ok: boolean; reason?: OpenReason; exitCode: ExitCode; alreadyRunning: boolean; launched: boolean; endpoint?: string; waitedMs: number; message: string }`
  - `runOpen(opts: OpenOpts, deps: OpenDeps): Promise<OpenResult>`
  - `defaultProbeBridge(): Promise<string | null>`
  - `defaultOpenDeps(): OpenDeps`

- [ ] **Step 1: Add the new exit code**

In `src/errors.ts`, add `NOT_INSTALLED: 6` to the `EXIT` object (after `SERVER: 5`):

```ts
export const EXIT = {
  OK: 0,
  USAGE: 2,
  NETWORK: 3,
  AUTH: 4,
  SERVER: 5,
  NOT_INSTALLED: 6,
} as const
```

- [ ] **Step 2: Export `isPidAlive` from discovery**

In `src/discovery.ts`, change the declaration `function isPidAlive(` to `export function isPidAlive(` (no other change — existing callers are unaffected).

- [ ] **Step 3: Write the failing tests**

`src/commands/open.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { EXIT } from '../errors'
import { type OpenDeps, runOpen } from './open'

const READY = 'http://127.0.0.1:16800'

function deps(over: Partial<OpenDeps> = {}): OpenDeps {
  return {
    platform: 'darwin',
    spawnOpener: vi.fn().mockResolvedValue({ code: 0 }),
    probeBridge: vi.fn().mockResolvedValue(null),
    sleep: vi.fn().mockResolvedValue(undefined),
    now: vi.fn().mockReturnValue(0),
    ...over,
  }
}

describe('runOpen', () => {
  it('rejects a remote --endpoint without probing or launching', async () => {
    const d = deps()
    const r = await runOpen({ endpoint: 'http://nas.local:16801' }, d)
    expect(r).toMatchObject({
      ok: false,
      reason: 'remote_endpoint',
      exitCode: EXIT.USAGE,
    })
    expect(d.spawnOpener).not.toHaveBeenCalled()
    expect(d.probeBridge).not.toHaveBeenCalled()
  })

  it('reports already-running and does not wait when the bridge is up', async () => {
    const d = deps({ probeBridge: vi.fn().mockResolvedValue(READY) })
    const r = await runOpen({}, d)
    expect(r).toMatchObject({
      ok: true,
      alreadyRunning: true,
      launched: false,
      endpoint: READY,
      exitCode: EXIT.OK,
    })
    // opener still fired (best-effort focus), but we never slept/waited
    expect(d.spawnOpener).toHaveBeenCalledTimes(1)
    expect(d.sleep).not.toHaveBeenCalled()
  })

  it('ignores an opener failure when Motrix is already running', async () => {
    const d = deps({
      probeBridge: vi.fn().mockResolvedValue(READY),
      spawnOpener: vi.fn().mockResolvedValue({ code: 1 }),
    })
    const r = await runOpen({}, d)
    expect(r.ok).toBe(true)
    expect(r.alreadyRunning).toBe(true)
  })

  it('launches then succeeds once the bridge comes up', async () => {
    const d = deps({
      probeBridge: vi
        .fn()
        .mockResolvedValueOnce(null) // pre-launch probe
        .mockResolvedValueOnce(null) // poll #1
        .mockResolvedValueOnce(READY), // poll #2
      now: vi.fn().mockReturnValueOnce(0).mockReturnValue(500),
    })
    const r = await runOpen({}, d)
    expect(r).toMatchObject({
      ok: true,
      alreadyRunning: false,
      launched: true,
      endpoint: READY,
      exitCode: EXIT.OK,
      waitedMs: 500,
    })
    expect(d.sleep).toHaveBeenCalled()
  })

  it('returns not_installed (exit 6) when the opener exits non-zero', async () => {
    const d = deps({ spawnOpener: vi.fn().mockResolvedValue({ code: 1 }) })
    const r = await runOpen({}, d)
    expect(r).toMatchObject({
      ok: false,
      reason: 'not_installed',
      exitCode: EXIT.NOT_INSTALLED,
    })
    expect(r.message).toContain('https://motrix.app')
  })

  it('returns opener_missing (exit 3) when the opener cannot be spawned', async () => {
    const err = Object.assign(new Error('spawn xdg-open ENOENT'), {
      code: 'ENOENT',
    })
    const d = deps({
      platform: 'linux',
      spawnOpener: vi.fn().mockResolvedValue({ code: null, spawnError: err }),
    })
    const r = await runOpen({}, d)
    expect(r).toMatchObject({
      ok: false,
      reason: 'opener_missing',
      exitCode: EXIT.NETWORK,
    })
  })

  it('times out (exit 3) if the bridge never comes up', async () => {
    const d = deps({
      probeBridge: vi.fn().mockResolvedValue(null),
      now: vi
        .fn()
        .mockReturnValueOnce(0) // start
        .mockReturnValueOnce(0) // poll #1 elapsed check
        .mockReturnValueOnce(1000) // poll #2 elapsed check → >= timeout
        .mockReturnValue(1000), // waitedMs
    })
    const r = await runOpen({ timeout: 1000 }, d)
    expect(r).toMatchObject({
      ok: false,
      reason: 'launch_timeout',
      exitCode: EXIT.NETWORK,
      waitedMs: 1000,
    })
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm exec vitest run src/commands/open.test.ts`
Expected: FAIL — cannot find module `./open` / `runOpen is not a function`.

- [ ] **Step 5: Write the implementation**

`src/commands/open.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { type EndpointFile, endpointFilePath, isPidAlive } from '../discovery'
import { EXIT, type ExitCode } from '../errors'
import { openerFor, type SpawnOpener, spawnOpener } from '../launch'

const POLL_MS = 250
const DEFAULT_TIMEOUT_MS = 15000

export interface OpenOpts {
  timeout?: number
  endpoint?: string
}

export interface OpenDeps {
  platform: NodeJS.Platform
  spawnOpener: SpawnOpener
  /** Base URL when the local bridge is up, else null. */
  probeBridge: () => Promise<string | null>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export type OpenReason =
  | 'remote_endpoint'
  | 'not_installed'
  | 'launch_timeout'
  | 'opener_missing'

export interface OpenResult {
  ok: boolean
  reason?: OpenReason
  exitCode: ExitCode
  alreadyRunning: boolean
  launched: boolean
  endpoint?: string
  waitedMs: number
  message: string
}

export async function runOpen(
  opts: OpenOpts,
  deps: OpenDeps
): Promise<OpenResult> {
  const { platform, spawnOpener: fire, probeBridge, sleep, now } = deps
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS

  if (opts.endpoint) {
    return {
      ok: false,
      reason: 'remote_endpoint',
      exitCode: EXIT.USAGE,
      alreadyRunning: false,
      launched: false,
      waitedMs: 0,
      message:
        'open only launches the local desktop app; a remote --endpoint cannot be launched',
    }
  }

  const before = await probeBridge()
  // Fire the opener in every case: cold-start when down, focus when up.
  const fired = await fire(openerFor(platform), 'motrix://')

  if (before !== null) {
    return {
      ok: true,
      exitCode: EXIT.OK,
      alreadyRunning: true,
      launched: false,
      endpoint: before,
      waitedMs: 0,
      message: `Motrix already running (${before})`,
    }
  }

  if (fired.spawnError) {
    return {
      ok: false,
      reason: 'opener_missing',
      exitCode: EXIT.NETWORK,
      alreadyRunning: false,
      launched: false,
      waitedMs: 0,
      message: 'could not open a URL on this system — start Motrix manually',
    }
  }

  if (fired.code !== 0) {
    return {
      ok: false,
      reason: 'not_installed',
      exitCode: EXIT.NOT_INSTALLED,
      alreadyRunning: false,
      launched: false,
      waitedMs: 0,
      message:
        'Motrix desktop app not found — install it from https://motrix.app, or use --endpoint for a remote server',
    }
  }

  const start = now()
  for (;;) {
    const endpoint = await probeBridge()
    if (endpoint !== null) {
      return {
        ok: true,
        exitCode: EXIT.OK,
        alreadyRunning: false,
        launched: true,
        endpoint,
        waitedMs: now() - start,
        message: `Motrix is ready (${endpoint})`,
      }
    }
    if (now() - start >= timeout) {
      return {
        ok: false,
        reason: 'launch_timeout',
        exitCode: EXIT.NETWORK,
        alreadyRunning: false,
        launched: false,
        waitedMs: now() - start,
        message: `Motrix was launched but its bridge did not come up within ${Math.round(
          timeout / 1000
        )}s. Try --timeout <ms>; if Motrix isn't installed, get it at https://motrix.app`,
      }
    }
    await sleep(POLL_MS)
  }
}

/** TCP reachability check — the bridge listens on 127.0.0.1:<port>. */
function tcpConnectable(
  host: string,
  port: number,
  timeoutMs = 1000
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** Default probe: endpoint.json present + pid alive + port accepting TCP. */
export async function defaultProbeBridge(): Promise<string | null> {
  let file: EndpointFile
  try {
    const raw = await readFile(
      endpointFilePath(process.platform, process.env, homedir()),
      'utf-8'
    )
    file = JSON.parse(raw) as EndpointFile
  } catch {
    return null
  }
  if (!file.port || !file.pid || !isPidAlive(file.pid)) return null
  const up = await tcpConnectable('127.0.0.1', file.port)
  return up ? `http://127.0.0.1:${file.port}` : null
}

export function defaultOpenDeps(): OpenDeps {
  return {
    platform: process.platform,
    spawnOpener,
    probeBridge: defaultProbeBridge,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm exec vitest run src/commands/open.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 7: Typecheck + lint + commit**

```bash
pnpm typecheck
pnpm lint
git add src/errors.ts src/discovery.ts src/commands/open.ts src/commands/open.test.ts
git commit -m "feat(open): add runOpen orchestrator + NOT_INSTALLED exit code"
```

---

### Task 3: Register the `open` command (`src/program.ts`)

**Files:**
- Modify: `src/program.ts`

**Interfaces:**
- Consumes: `runOpen`, `defaultOpenDeps`, `type OpenResult` (Task 2); `wantsJson` (`src/output.ts`).

- [ ] **Step 1: Add imports**

At the top of `src/program.ts`, add (keep biome import ordering — group with the other `./commands/*` and `./` imports):

```ts
import { defaultOpenDeps, runOpen } from './commands/open'
import { wantsJson } from './output'
```

- [ ] **Step 2: Register the command**

In `buildProgram()`, add this block (place it after the `stats` command, before `pair`):

```ts
  program
    .command('open')
    .description(
      'Launch the local desktop Motrix and wait until its bridge is ready.'
    )
    .option('--timeout <ms>', 'ms to wait for the bridge after launching', intArg)
    .action(async (opts: { timeout?: number }) => {
      // NOTE: `open` deliberately does NOT use ioFromGlobals/discoverEndpoint —
      // those throw EXIT.NETWORK when the bridge is down, the case open handles.
      const global = program.opts<GlobalOpts>()
      const result = await runOpen(
        { timeout: opts.timeout, endpoint: global.endpoint },
        defaultOpenDeps()
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

- [ ] **Step 3: Write a registration test**

Append to `src/program.test.ts` (inside the existing top-level `describe`, matching its style):

```ts
  it('registers the open command with a --timeout option', () => {
    const program = buildProgram()
    const open = program.commands.find((c) => c.name() === 'open')
    expect(open).toBeDefined()
    expect(open?.options.some((o) => o.long === '--timeout')).toBe(true)
  })
```

(If `buildProgram` is not yet imported in `program.test.ts`, add it to the existing `from './program'` import.)

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm exec vitest run src/program.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Manual smoke**

```bash
pnpm build
node dist/bin/motrix.js open --help          # shows the open command + --timeout
node dist/bin/motrix.js open --endpoint http://x:1 --json   # {"ok":false,"reason":"remote_endpoint",...}, exit 2
echo "exit: $?"
```

Expected: `--help` lists `open`; the remote probe prints the JSON result with `reason:"remote_endpoint"` and exits `2`.

- [ ] **Step 6: Lint + commit**

```bash
pnpm lint
git add src/program.ts src/program.test.ts
git commit -m "feat(open): wire the open command into the CLI"
```

---

### Task 4: Docs + version bump

**Files:**
- Modify: `README.md`, `README.zh-CN.md` (command table + exit-code table)
- Modify: `SKILL.md` (command list + exit codes + When-to-use)
- Modify: `package.json` (version → `0.2.0`)

- [ ] **Step 1: README.md**

In the Commands table, add a row (after `motrix stats`):

```markdown
| `motrix open [--timeout <ms>]` | Launch the local desktop app and wait until its bridge is ready |
```

In the exit-code table, add a row after `5`:

```markdown
| `6` | Not installed — the Motrix desktop app could not be launched (`motrix open`) |
```

- [ ] **Step 2: README.zh-CN.md**

In the 命令 table, add after `motrix stats`:

```markdown
| `motrix open [--timeout <ms>]` | 启动本地桌面 app 并等待其 bridge 就绪 |
```

In the 退出码 table, add after `5`:

```markdown
| `6` | 未安装——无法启动 Motrix 桌面 app（`motrix open`） |
```

- [ ] **Step 3: SKILL.md**

- Add to the command list (after `motrix stats`):
  ```markdown
  motrix open [--timeout <ms>]                              # launch the local desktop app + wait for its bridge
  ```
- Change the exit-codes list to append `6`:
  ```markdown
  - `6` not-installed — the Motrix desktop app could not be launched (`motrix open`)
  ```
- In *When to use*, append to the sentence about exit code `3`:
  > If Motrix isn't running, run `motrix open` first to launch the local desktop app (exit `6` if it isn't installed), then retry.

- [ ] **Step 4: Bump version**

In `package.json`, change `"version": "0.1.1"` to `"version": "0.2.0"`.

- [ ] **Step 5: Verify + commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add README.md README.zh-CN.md SKILL.md package.json
git commit -m "docs(open): document motrix open + exit code 6; bump to 0.2.0"
```

Expected: all green (existing suite + the new `launch`/`open`/`program` tests).

---

## Release (post-plan — gated)

Not a plan task; run after the plan is complete and the user approves:

```bash
rm -rf dist && npm publish --dry-run   # confirm dist/bin/motrix.js + version 0.2.0
```

Then, on explicit user approval (2FA OTP required):

```bash
npm publish --otp=<code>
git tag -a v0.2.0 -m "release: v0.2.0"
git push origin main --follow-tags
```

## Self-review notes

- **Spec coverage:** command surface (T3), launch mechanism (T1), readiness probe (T2 `defaultProbeBridge`), idempotency + timeout + not-installed + opener-missing + remote (T2 tests), `--json` result & exit codes (T2/T3), docs + version (T4). Windows caveat is inherent (documented in the spec; no code path needed — `not_installed` simply may not trigger on Windows).
- **No new deps** — `node:child_process`, `node:net`, `node:fs/promises`, `node:os` are built-ins.
- **`--json.reason`** is delivered by the structured `OpenResult` (T2) rendered in T3, not by a change to `runMain`'s error path.
