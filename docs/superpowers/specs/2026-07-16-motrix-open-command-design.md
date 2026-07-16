# Design — `motrix open` (launch the desktop app)

- **Date:** 2026-07-16
- **Status:** Approved (brainstorming)
- **Target version:** `@motrix/cli` 0.2.0 (new command → minor bump)

## Motivation

The CLI is a **client** of a *running* Motrix. Today, when the desktop app is
not running, every command fails fast with `EXIT.NETWORK (3)` — deliberately, so
callers surface the problem instead of retrying blindly. But that leaves a real
gap: from a terminal (or an AI agent), there is no first-class way to *bring
Motrix up* before issuing commands. `motrix open` fills exactly that gap.

## Goals

- An explicit `motrix open` command that launches the local desktop Motrix and
  returns success only once its bridge is ready to accept commands.
- Idempotent: if Motrix is already running, focus its window and succeed
  immediately.
- Cross-platform (macOS / Windows / Linux).
- Distinguish "app not installed" from "launched but timed out" for both humans
  and agents.

## Non-goals

- **No auto-launch** on other commands, and **no `--launch` flag**. `list`,
  `add`, etc. keep their fail-fast behavior (`EXIT.NETWORK` when the bridge is
  down). `open` is the single, explicit entry point.
- **No launching a remote server.** `open` is local-desktop only; a remote
  `--endpoint` cannot be launched.

## Command surface

```
motrix open [--timeout <ms>]
```

Plus the global flags `--json` (and `--endpoint` / `--token`, see below).

- `--timeout <ms>` — how long to wait for the bridge after launching. Default
  `15000`.

## Behavior

1. **Reject remote endpoints.** If `--endpoint <url>` (or the resolved endpoint
   is not the local desktop) is supplied, exit `EXIT.USAGE (2)` with reason
   `remote_endpoint` — a remote app cannot be launched.
2. **Check readiness first.** Probe the local bridge (see *Readiness* below). If
   it is already up, set `alreadyRunning = true`.
3. **Fire the opener.** Invoke the platform opener on the bare `motrix://` URL
   (see *Launch mechanism*). The desktop app registers the `motrix` scheme and
   already treats a bare `motrix://` as "show / focus the window", so the same
   call both cold-starts a stopped app and focuses a running one.
   - If `alreadyRunning`, the opener is **best-effort focus**: its failure is
     ignored (we already have a live bridge).
   - Otherwise, a **non-zero opener exit means the scheme has no handler → the
     app is not installed** → exit `EXIT.NOT_INSTALLED (6)`, reason
     `not_installed`.
4. **Wait for readiness** (skip if `alreadyRunning`). Poll until the bridge is
   up or `--timeout` elapses.
   - Ready → success.
   - Timeout → exit `EXIT.NETWORK (3)`, reason `launch_timeout`.

### Launch mechanism

Use the registered `motrix://` URL scheme via the platform opener — install-path
independent, uniform across platforms, and the app's `protocol-manager` already
does the right thing for a bare URL:

| Platform | Opener command |
|----------|----------------|
| macOS (`darwin`) | `open motrix://` |
| Windows (`win32`) | `cmd /c start "" motrix://` |
| Linux (other) | `xdg-open motrix://` |

The opener resolver (`openerFor(platform)` → `{ cmd, args }`) is a pure function,
injectable in tests. The spawn wrapper is injectable too (no real process in
unit tests).

### Readiness

Reuse `discovery.ts`. The bridge is "up" when **all** hold:

1. `<userData>/bridge/endpoint.json` exists and parses (the app writes it
   *after* `server.start()`),
2. its `pid` is alive (`process.kill(pid, 0)`, per `isPidAlive`),
3. a TCP connection to `127.0.0.1:<port>` succeeds.

Poll interval ~250 ms until ready or timeout. The endpoint reader, `pidAlive`,
TCP connector, `sleep`, and clock are all injectable — unit tests use no real
filesystem, sockets, or wall-clock.

## Exit codes and error taxonomy

The command adds **one** new code to the existing contract (`0/2/3/4/5`):

| Situation | exit | `--json.reason` | Message (essence) |
|-----------|------|-----------------|-------------------|
| Ready (launched or already running) | `0` | — | `Motrix is ready (http://127.0.0.1:PORT)` / `Motrix already running` |
| Remote `--endpoint` given | `2` USAGE | `remote_endpoint` | `open only launches the local desktop app; a remote --endpoint cannot be launched` |
| App not installed (opener non-zero) | `6` NOT_INSTALLED | `not_installed` | `Motrix desktop app not found — install it from https://motrix.app, or use --endpoint for a remote server` |
| Launched but bridge did not come up in time | `3` NETWORK | `launch_timeout` | `Motrix was launched but its bridge did not come up within Ns. Try --timeout <ms>; if Motrix isn't installed, get it at https://motrix.app` |
| No usable opener (e.g. no `xdg-open`) | `3` NETWORK | `opener_missing` | `could not open a URL on this system — start Motrix manually` |

`EXIT.NOT_INSTALLED = 6` is added to `src/errors.ts`.

## Output

- **TTY** — a one-line human summary (`Motrix is ready …` / `already running`).
- **`--json` / piped** — on success:

  ```json
  { "ok": true, "alreadyRunning": false, "launched": true,
    "endpoint": "http://127.0.0.1:16800", "waitedMs": 1234 }
  ```

  On failure, the standard CLI error JSON, carrying `reason` (and the exit code
  is the process exit code).

## Caveats

- **The `motrix://` scheme is only registered by an installed (packaged) app.**
  A dev / unpacked build won't be launchable this way — that surfaces as
  `not_installed`.
- **Windows cannot always distinguish not-installed from timeout.**
  `cmd /c start motrix://` does not reliably return non-zero for an unregistered
  scheme, so on Windows a not-installed app may fall through to `launch_timeout
  (3)` rather than `not_installed (6)`. The timeout message therefore also hints
  at installation. Exit `6` is reliably produced on macOS and Linux.
- **Linux executable is also named `motrix`.** The packaged app's binary is
  `motrix` (electron-builder `executableName`), same as this CLI's bin. They do
  not normally collide (the app ships via a `.desktop` launcher, not on `PATH`),
  but launching via the URL scheme sidesteps the question entirely.

## Architecture and files

| File | Change |
|------|--------|
| `src/launch.ts` (new) | `openerFor(platform)` → `{ cmd, args }`; a thin injectable spawn wrapper returning the opener's exit code |
| `src/commands/open.ts` (new) | Orchestrator: reject-remote → probe → fire opener → wait; pure, with injected `opener`, `readEndpointFile`, `pidAlive`, `tcpConnect`, `sleep`, `now` |
| `src/errors.ts` | Add `NOT_INSTALLED: 6` to `EXIT` |
| `src/program.ts` | Register the `open` command |
| `src/discovery.ts` | Reuse existing helpers; extract a small `isBridgeUp(...)` if convenient (no behavior change to existing callers) |

## Testing (TDD)

Unit tests only — no real process, socket, filesystem, or wall-clock (all
injected), mirroring `client.test.ts` (`fetchImpl`) and `discovery` (`pidAlive`):

- `src/launch.test.ts` — `openerFor` returns the right `{cmd,args}` for
  `darwin` / `win32` / linux.
- `src/commands/open.test.ts`:
  - already running → `alreadyRunning:true`, no wait, opener fired best-effort, exit 0
  - cold start → opener fired, poll succeeds after N ticks, `launched:true`, exit 0
  - opener non-zero → `not_installed`, exit 6
  - opener success + poll never ready → `launch_timeout`, exit 3, honors `--timeout`
  - opener spawn ENOENT → `opener_missing`, exit 3
  - remote `--endpoint` → `remote_endpoint`, exit 2
  - `--json` shape on success

## Documentation updates (part of this change)

- `README.md` + `README.zh-CN.md`: add `open` to the command table; add the
  `6` row to the exit-code table; mention the launch behavior.
- `SKILL.md`: add `motrix open` to the command list; add `6` to the exit-code
  line; in *When to use*, note that if Motrix isn't running an agent can run
  `motrix open` first instead of only surfacing exit 3.

## Version

New user-facing command → **0.2.0** (semver minor). Ships as a normal release
(`npm publish` + `v0.2.0` tag).
