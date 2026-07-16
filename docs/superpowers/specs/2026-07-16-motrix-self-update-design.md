# Design — `motrix self-update` (update the CLI itself)

- **Date:** 2026-07-16
- **Status:** Approved (brainstorming)
- **Target version:** `@motrix/cli` 0.3.0 (new command → minor bump)

## Motivation

`@motrix/cli` is distributed on npm and installed globally. Today the only way
to update it is to remember the package name and re-run the install command by
hand. pnpm's `self-update` shows the UX we want: one explicit command that
resolves the target version, refuses when the environment isn't one it can
safely update, and never leaves a broken install behind.

pnpm's *mechanics* do not transfer, though. pnpm owns its install dir
(`PNPM_HOME`): it installs each version side-by-side and re-points shims. An
npm-installed CLI owns nothing — the package manager owns the global
`node_modules` tree and the bin shims, and mutating those behind its back
desyncs its metadata. So the correct mechanic for us is the one used by Vercel
CLI and gemini-cli: **detect which package manager installed us, then delegate
to it** (`npm i -g @motrix/cli@<resolved>`). What we take from pnpm is the
guard-rail design: refuse-when-uncertain (its corepack guard), resolve before
install, downgrade protection, and fail-without-breaking-the-old-version.

## Goals

- An explicit `motrix self-update [target]` command that updates the globally
  installed CLI via the package manager that installed it.
- pnpm-style target spec: no argument (= `latest` dist-tag), exact version,
  semver range, or dist-tag. Explicit versions allow rollback.
- Detect and execute for npm / pnpm / yarn / bun / volta global installs;
  refuse with the correct manual command for everything else.
- Never guess: an uncertain install source means print instructions, don't
  mutate (the Claude Code #28625 double-install accident is the failure mode
  this prevents).
- A failed update leaves the current install fully working.
- First-class `--json` output and exit codes so AI agents can branch on the
  result.
- Prerequisite, shipped in the same change: `motrix --version` (does not exist
  today), with the same version source threaded into `pair.ts`'s
  `clientVersion` (currently always `'unknown'`).

## Non-goals

- **No passive update notification** (registry check + banner on normal
  commands). Explicitly descoped; may be layered on later.
- **No background auto-update.** Especially dangerous for a CLI that AI agents
  drive mid-session — code must not swap underneath a running workflow.
- **No Homebrew / standalone-binary channels.** They don't exist for this
  package; the cascade leaves room if they ever do.
- **No Motrix-app version negotiation.** MDXP does not expose the app version;
  `client.ts` keeps its plain-text version-drift hints. Future work.

## Command surface

```
motrix self-update [target] [--dry-run]
```

- `target` — anything the npm resolver accepts: exact version (`0.2.1`), range
  (`0.2`, `^0.2.0`), or dist-tag (`latest`, `next`). Default `latest`.
- `--dry-run` — run detection + resolution + guards, report what would be
  executed, change nothing.
- Global `--json` applies. `--endpoint` / `--token` are irrelevant (no bridge
  involved); like `open`, the command bypasses `ioFromGlobals()`.

## Behavior

### Step 0 — own version (`src/pkg.ts`, new)

`readOwnPackageJson()` walks upward from `import.meta.url` to the nearest
`package.json` whose `name` is `@motrix/cli` (bounded, ~4 levels). Depth-
independent, so it works both from `src/**` in dev and from the bundled
`dist/bin/motrix.js` (tsup does not inline `package.json`, but `files` ships it
alongside `dist/`). Feeds `program.version()`, `self-update`, and
`pair.ts` `clientVersion`.

### Step 1 — install-source detection (`src/install-source.ts`, new)

A pure cascade over `realpath(process.argv[1])` (realpath first — bin shims are
symlinks on POSIX). All inputs injectable (`argv1`, `realpath`, `env`,
`platform`, `spawn`). First match wins:

| # | Signal | Verdict | Action |
|---|--------|---------|--------|
| 1 | path contains `/.npm/_npx/` or `/npm/_npx/` | `npx` | refuse — one-off run, self-update meaningless |
| 2 | `/.pnpm/_pnpx/` or `/.cache/pnpm/dlx/` | `pnpm-dlx` | refuse |
| 3 | `/.bun/install/cache/` | `bunx` | refuse |
| 4 | not under any `node_modules/` | `checkout` | refuse — "running from a checkout; use git pull + pnpm build" |
| 5 | `/.volta/` or `/Volta/` | `volta` | execute `volta install @motrix/cli@<v>` |
| 6 | under `$PNPM_HOME`, or pnpm global fragments (`/.local/share/pnpm/`, `/Library/pnpm/`, `/AppData/Local/pnpm/`, `/.pnpm/global/`) | `pnpm-global` | execute `pnpm add -g @motrix/cli@<v>` |
| 7 | `/.config/yarn/global/` (Yarn Classic default), `/.yarn/global/`, or `/Yarn/Data/global/` (Windows) | `yarn-global` | execute `yarn global add @motrix/cli@<v>` |
| 8 | `/.bun/install/global/` | `bun-global` | execute `bun add -g @motrix/cli@<v>` |
| 9 | realpath is inside `npm root -g` (spawned, realpath-compared) | `npm-global` | execute `npm i -g @motrix/cli@<v>` |
| 10 | nothing matched | `unknown` | refuse — do **not** present `npm i -g` as the fix; warn that a blind npm install may create a PATH-shadowing copy and tell the user to update with the manager they installed with |

The `yarn-global` row must include `/.config/yarn/global/`: that (not
`/.yarn/global/`) is Yarn Classic's *default* global directory, and missing it
misclassifies a normal yarn install as `unknown` — which historically led to
recommending npm and creating the very shadow copy the cascade exists to avoid.

Cheap synchronous path checks first; the only subprocess (`npm root -g`) is the
last probe. The result is a plain data object:

```ts
type InstallSource =
  | { kind: 'npm-global' | 'pnpm-global' | 'yarn-global' | 'bun-global' | 'volta'
      installArgs: string[]        // e.g. ['pnpm', 'add', '-g', '@motrix/cli@X']
      globalRoot?: string }        // known for npm (from `npm root -g`)
  | { kind: 'npx' | 'pnpm-dlx' | 'bunx' | 'checkout' | 'unknown'
      reason: string }
// every variant also carries manualCommand: string
```

### Step 2 — resolve before install (anti-TOCTOU)

Spawn `npm view @motrix/cli@<target> version --json` from a **user-owned
neutral directory** (`os.homedir()` — see the box below). A global operation
must not be captured by the surrounding project's `.npmrc`/lockfile (Vercel's
lesson), and the neutral dir must not be a shared temp dir either. If npm is
absent (spawn `ENOENT`) and the detected source is pnpm, fall back to
`pnpm view`. Parsing:

- single version → string; range match → array, pick highest via an in-house
  ~15-line `compareSemver` (numeric x.y.z + simplified prerelease precedence;
  no new dependency).
- empty output (npm exits 0 for a non-matching range) → resolve error.
- `EINVALIDTAGNAME`-style errors (the spec itself is malformed) →
  `EXIT.USAGE (2)`, reason `bad-target`.
- `E404` / network error → resolve error, `EXIT.NETWORK (3)`.

### Step 3 — guards (pnpm semantics)

- resolved == current → **"Already up to date"**, exit `0`, `changed: false`.
- implicit `latest` and resolved < current (local build ahead of registry) →
  refuse the downgrade, exit `0`, `changed: false`, hint
  `motrix self-update <version>` to downgrade explicitly.
- explicit `target` may downgrade — that is the rollback path.

### Step 4 — `--dry-run` stops here

Reports `{ from, to, method, command }`, exit `0`.

### Step 5 — delegate the install

Spawn `installArgs` from the **neutral directory** (see the box below), all
output buffered (npm can prompt mid-install; piped-but-shown output looks like
a hang). On non-zero exit: print the buffered output, the manual command, and
fail with `EXIT.SELF_UPDATE_FAILED (7)`. If stderr contains `EACCES` /
`EPERM`, append npm's official prefix-relocation guidance
(docs.npmjs.com → "Resolving EACCES permissions errors") — **never suggest
sudo**.

> **Neutral working directory (security).** Every package-manager subprocess
> — `npm root -g` (detection), `npm/pnpm view` (resolve), the installer, and
> the verify run — uses `cwd = os.homedir()`, not `os.tmpdir()`. On Linux
> `os.tmpdir()` is `/tmp`, which is world-writable; package managers read
> config from cwd **and its ancestors** (Yarn Classic merges ancestor
> `.yarnrc` and honors `yarn-path`), so another local user could pre-plant
> `/tmp/.yarnrc` and have a recognized self-update execute their code as the
> victim. Home is user-owned, outside `/tmp`, and its ancestors are
> root-owned — no injection surface — while the user's own `~/.npmrc`
> (registry/auth) is honored regardless of cwd, so the "ignore the project's
> config" property is preserved.

### Step 6 — verify

- **npm / pnpm** (global root obtainable via `npm root -g` / `pnpm root -g`):
  spawn `node <root>/@motrix/cli/dist/bin/motrix.js --version` — bypasses
  PATH, cross-platform. Output ≠ resolved target → `SELF_UPDATE_FAILED (7)`.
  If the root query itself fails (`pnpm root -g` has broken across pnpm's
  global-layout changes, pnpm/pnpm#11528), degrade to the PATH-based
  warning-only check below instead of hard-failing.
- **yarn / bun / volta**: PATH-based check only — resolve `motrix` via an
  injectable PATH lookup and run `--version`. Mismatch → **success with a
  shadowing warning** (the PM reported success; a different install earlier on
  PATH is the likely cause), never a hard failure.
- Windows note: the installer rewrites the running command's `.cmd`/`.ps1`
  shims mid-flight. Safe — node already holds the JS in memory — but the
  command prints its result and exits promptly after verification; nothing
  else runs post-install.

## Exit codes and error taxonomy

Adds **one** code to the contract (`0/2/3/4/5/6`):
`EXIT.SELF_UPDATE_FAILED = 7` in `src/errors.ts`.

| Situation | exit | `--json.reason` |
|-----------|------|-----------------|
| Updated successfully | `0` | — (`changed: true`) |
| Already up to date | `0` | `already-up-to-date` (`changed: false`) |
| Implicit-latest downgrade refused | `0` | `downgrade-refused` (`changed: false`) |
| Dry run | `0` | — (`dryRun: true`) |
| Unusable target spec (malformed) | `2` USAGE | `bad-target` |
| Registry resolve failed / network | `3` NETWORK | `resolve-failed` |
| npx / dlx / bunx one-off run | `7` | `unsupported-ephemeral` |
| Running from a checkout | `7` | `unsupported-checkout` |
| Unknown install source | `7` | `unknown-install` |
| Installer exited non-zero (tree unchanged) | `7` | `install-failed` (`changed: false`) |
| Post-install verification mismatch (npm/pnpm) | `7` | `verify-failed` (`changed: true`) |

**`verify-failed` is a partially-mutated state, not a no-op.** The installer
already exited `0`, so the global tree *was* mutated — the result reports
`changed: true` even though `ok: false`, and `manualCommand` is the
**rollback to `from`** via the detected manager (e.g. `npm i -g @motrix/cli@0.2.1`),
not a re-run of the forward install. We deliberately do **not** auto-rollback:
verification can fail on a perfectly good install (e.g. a stale entry-path
assumption), so silently reinstalling `from` could downgrade a healthy CLI and
adds a second fallible mutation. Instead we surface the honest state plus the
exact recovery command and let the operator decide. `install-failed`, by
contrast, means the installer itself exited non-zero, so the tree is untouched
(`changed: false`) and the old version still works.

Every `7` payload carries `manualCommand`, and its human message ends with
"You can run it manually: `<cmd>`".

One nuance inside `3`: "npm itself is not installed" also resolves to `3`
(`resolve-failed`), but unlike a transient network error it will not heal on
retry — the message says so ("install npm or update manually").

## Output

- **TTY** — one line: `Updated @motrix/cli 0.2.1 → 0.3.0 (pnpm)` /
  `Already up to date (0.2.1)`.
- **`--json` / piped** — success:

  ```json
  { "ok": true, "changed": true, "from": "0.2.1", "to": "0.3.0",
    "method": "pnpm-global", "command": "pnpm add -g @motrix/cli@0.3.0" }
  ```

  No-op: `{ "ok": true, "changed": false, "reason": "already-up-to-date",
  "from": "0.2.1", "to": "0.2.1" }` — one shape; fields that don't apply
  (`warning`, `method`, …) are omitted, never `null`, and `from`/`to` appear
  whenever both versions are known (refusals that fire before resolution
  carry neither). Dry run adds `"dryRun": true` (the installer command rides
  the same `command` field). Failures carry `reason` + `manualCommand`.

## Caveats

- **Detection is heuristic.** PM global layouts churn across majors (pnpm has
  moved its global dir twice). The `unknown → refuse` bucket is the safety
  net; new fragments get added as layouts change.
- **nvm / fnm**: an npm-global install lives inside the *current* node
  version's tree. Switching node versions resurrects the old CLI. Not
  detected in v1; documented caveat only.
- **`npm view` quirk**: non-matching *range* → empty output with exit 0;
  non-existent *package/tag* → E404. Both handled as resolve errors, but the
  messages differ.
- **pnpm ≥ 10 blocks dependency postinstall scripts** by default. `@motrix/cli`
  has none (runtime dep is `commander` only) — re-check if native deps are
  ever added.
- **volta verify is PATH-only**: volta's image layout is private; we trust
  `volta install`'s exit code and the PATH check.

## Architecture and files

| File | Change |
|------|--------|
| `src/pkg.ts` (new) | `readOwnPackageJson()` / `readOwnVersion()` — bounded upward walk to own `package.json` |
| `src/install-source.ts` (new) | `detectInstallSource(ctx)` — the pure cascade; per-PM install/manual command builders |
| `src/commands/self-update.ts` (new) | `runSelfUpdate(opts, ctx)` orchestrator returning a structured result (modeled on `open.ts`); injected `spawn`, `realpath`, `env`, `platform`, `argv1`, `tmpdir`, PATH lookup |
| `src/errors.ts` | Add `SELF_UPDATE_FAILED: 7` to `EXIT` |
| `src/program.ts` | Register `self-update`; add `program.version(readOwnVersion())`; pass `clientVersion` into `pair` |
| `src/launch.ts` | Reuse the injectable spawn-wrapper pattern (extract/share if convenient; no behavior change to `open`) |

## Testing (TDD)

Unit tests only — no real processes, filesystem, or network (all injected),
mirroring `open.test.ts`:

- `src/pkg.test.ts` — version resolution from src-depth and dist-depth layouts.
- `src/install-source.test.ts` — every cascade row (1–10), realpath’d symlink
  inputs, `PNPM_HOME` env, `npm root -g` containment true/false/spawn-error.
- `src/commands/self-update.test.ts`:
  - happy path per executable source (npm/pnpm/yarn/bun/volta) → correct
    install args, `changed: true`, exit 0
  - refuse paths (npx/dlx/bunx/checkout/unknown) → exit 7, `manualCommand`
  - resolve: exact / range-pick-highest / dist-tag / empty-output / E404
  - guards: already-up-to-date; implicit-latest downgrade refused; explicit
    downgrade allowed
  - `--dry-run` performs no install spawn
  - installer non-zero → exit 7, buffered output surfaced; EACCES → guidance
    appended, no sudo anywhere
  - verify mismatch: npm/pnpm → exit 7; yarn/bun/volta → warning, exit 0
  - `--json` shapes for success / no-op / dry-run / failure
- `motrix --version` prints the package version.

## Documentation updates (part of this change)

- `README.md` + `README.zh-CN.md`: add `self-update` to the command table; add
  the `7` row to the exit-code table; document `--version`.
- `SKILL.md`: add `motrix self-update` and exit code `7`; note agents should
  treat `7` as "environment can't self-update — don't retry", vs `3` as
  retryable.

## Version

New user-facing command + new exit code → **0.3.0** (semver minor). Ships as a
normal release (`chore(release): v0.3.0` + tag + `pnpm publish`).
