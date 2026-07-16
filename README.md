# @motrix/cli

**English** · [简体中文](./README.zh-CN.md)

`motrix` is the command-line client for the [Motrix](https://motrix.app)
download manager, built for both humans and AI agents. It speaks **MDXP** (the
Motrix Download eXchange Protocol — JSON-RPC 2.0) to an already-running Motrix
over a unary `POST /mdxp` transport, and can target either a local desktop app
(auto-discovered) or a remote / headless Motrix server (paired once).

The CLI is a **client, not a download engine**—it does not download anything 
itself. Each command is a request sent to a running instance of Motrix, and 
the actual downloading is performed by Motrix.

## Requirements

- **Node.js ≥ 20**
- A reachable, running **Motrix** instance (desktop app or server).

## Installation

```bash
npm i -g @motrix/cli   # installs the `motrix` command globally
motrix --help
```

The published artifact is self-contained: the build inlines `@motrix/mdxp`, so a
global install pulls **no `@motrix/*` runtime dependencies** — only `commander`.

> If you already run the Motrix desktop app, prefer **Settings → Command-line
> tools → Install**, which runs the same `npm i -g @motrix/cli` for you and
> verifies your `PATH`.

## Quick start

```bash
motrix list                                            # list current tasks
motrix add https://example.com/f.zip --save-dir ~/Downloads
motrix watch --stats                                   # stream live progress until Ctrl-C
```

## Commands

| Command | Purpose |
|---------|---------|
| `motrix list [--status <s>] [--limit <n>] [--offset <n>]` | List download tasks |
| `motrix stats` | Aggregate speeds and task counts |
| `motrix add <url...> --save-dir <dir> [--filename <name>] [--header "K: V"] [--connections <n>] [--proxy <url>]` | Add HTTP(S) / FTP download(s) |
| `motrix add --magnet <uri> --save-dir <dir> [--select 0,2]` | Add a magnet link |
| `motrix add --torrent <file.torrent> --save-dir <dir>` | Add a `.torrent` file |
| `motrix pause <taskId>` | Pause a task |
| `motrix resume <taskId>` | Resume a task |
| `motrix remove <taskId> [--delete-files]` | Remove a task |
| `motrix watch [--task <id>] [--stats]` | Stream progress as NDJSON until interrupted |
| `motrix pair [--name <label>]` | Pair with a bridge via device code |
| `motrix describe` | Print the MDXP tool catalog |
| `motrix skill path \| install [dir]` | Locate / install the bundled agent skill |

Every command also accepts the global flags `--endpoint <url>`, `--token
<token>`, and `--json`.

## Connecting to Motrix

### Local desktop (zero-config)

By default the CLI auto-discovers a running desktop Motrix by reading
`<userData>/bridge/endpoint.json` (on macOS:
`~/Library/Application Support/Motrix/bridge/endpoint.json`), which carries the
bridge port and a machine-owner token. No setup is required.

### Remote / headless server

Run `motrix pair` once. It performs a device-code exchange over the REST
`/mdxp/pair/*` routes and prints a verification code; approve that code in the
Motrix UI. The issued token is stored in `~/.config/motrix/credentials.json`
(mode `0600`), keyed by endpoint, and reused automatically by later commands.

### Explicit overrides

- `--endpoint <url>` — e.g. `http://nas.local:16801`
- `--token <token>` — or the `MOTRIX_BRIDGE_TOKEN` environment variable

## Output and exit codes

The CLI adapts its output to the caller:

- **Interactive TTY** → a human-readable table / summary.
- **`--json`, or piped / non-TTY stdout** → a single JSON value, ready to parse.

Scripts and agents should branch on the **exit code**:

| Code | Meaning |
|------|---------|
| `0` | Success |
| `2` | Usage error (bad flags / arguments) |
| `3` | Network — the bridge is down or unreachable |
| `4` | Auth — token missing or rejected (re-run `motrix pair`) |
| `5` | Server — the bridge returned a JSON-RPC error |

**Version drift.** If the target Motrix does not recognize a method this CLI
sends (JSON-RPC `-32601`), or exposes no `/mdxp` bridge at all (HTTP 404), the
command fails with exit code `5` and a clear message asking you to update Motrix
or the CLI — never a raw protocol error. In `--json` mode the original JSON-RPC
`code` is preserved under `data` so callers can still branch programmatically.

## AI agent integration

`motrix` is designed to be driven safely by autonomous agents.

- **`motrix describe --json`** emits the authoritative MDXP tool catalog — every
  agent-callable method with its JSON-Schema (draft 2020-12) `inputSchema` and
  `outputSchema`. It is static (no bridge call) and always reflects the protocol
  version the CLI was built against, so it cannot drift from what the commands
  actually send. Use it to learn exact parameter shapes instead of guessing.
- **`motrix skill install [dir]`** installs the bundled `SKILL.md` agent skill
  (default `~/.claude/skills`, namespaced under `motrix/`); **`motrix skill
  path`** prints its location.

See [`SKILL.md`](./SKILL.md) for the agent-facing usage contract.

## Development

This repository is standalone (extracted from the Motrix app monorepo). It
depends on `@motrix/mdxp` from npm and `commander`; there is no sibling-path
link.

```bash
pnpm install
pnpm build       # tsup → dist/bin/motrix.js (mdxp inlined, commander external)
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # biome check .
node dist/bin/motrix.js --help
```

`tsup`'s `noExternal: [/^@motrix\//]` inlines `@motrix/mdxp` into the single-file
bundle, so the artifact runs without a `node_modules/@motrix/mdxp`. `commander`
stays a normal runtime dependency, installed by npm on `npm i -g @motrix/cli`.

## License

[MIT](./LICENSE) © Motrix
