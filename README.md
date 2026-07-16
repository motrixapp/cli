# @motrix/cli

`motrix` — a command-line client for the [Motrix](https://motrix.app) download
manager, designed to be driven by both humans and AI agents. It speaks MDXP
(JSON-RPC 2.0) to a running Motrix over a unary `POST /mdxp` transport, plus the
REST `/mdxp/pair/*` device-code routes for remote pairing.

## Install

```bash
npm i -g @motrix/cli      # installs the `motrix` command globally
motrix --help
```

Requires Node.js `>=20`. The published artifact is self-contained: the build
inlines `@motrix/mdxp`, so a global install pulls no `@motrix/*` runtime deps
(only `commander`).

> Prefer the desktop app's **Settings → Command-line tools → Install** button if
> you have Motrix installed — it runs the same `npm i -g @motrix/cli` for you.

## Usage

```bash
motrix list [--status <s>] [--limit <n>] [--offset <n>]
motrix stats
motrix add <url...> --save-dir <dir> [--filename <name>] [--header "K: V"] [--connections <n>] [--proxy <url>]
motrix add --magnet <uri> --save-dir <dir> [--select 0,2]
motrix add --torrent <file.torrent> --save-dir <dir>
motrix pause <taskId>
motrix resume <taskId>
motrix remove <taskId> [--delete-files]
motrix watch [--task <id>] [--stats]
motrix pair [--name <label>]
motrix describe
motrix skill path | install [dir]
```

Global flags: `--endpoint <url>`, `--token <token>`, `--json`.

### Connection

By default the CLI auto-discovers a local desktop Motrix via
`<userData>/bridge/endpoint.json` (port + machine-owner token). For a
remote/headless server, run `motrix pair` once (device-code approval in the
Motrix UI); the issued token is stored in `~/.config/motrix/credentials.json`
(mode 0600) keyed by endpoint and reused automatically. Or pass `--endpoint` +
`--token` / `MOTRIX_BRIDGE_TOKEN` explicitly.

### Output contract (agent-facing)

- **TTY** → a human-readable table/summary.
- **`--json` or piped (non-TTY)** → a single JSON value.
- **Exit codes**: `0` ok · `2` usage · `3` network (bridge down) · `4` auth
  (401/403) · `5` server error.

### For AI agents

- `motrix describe --json` emits the MDXP tool catalog — every agent-callable
  method with its JSON-Schema (2020-12) input/output. Static, no bridge call.
- `motrix skill install ~/.claude/skills` installs the shipped `SKILL.md` agent
  skill; `motrix skill path` prints its location.

## Develop

This repo is standalone (extracted from the Motrix app monorepo). It depends on
`@motrix/mdxp` from npm and `commander`; there is no sibling-path link.

```bash
pnpm install
pnpm build     # tsup → dist/bin/motrix.js (mdxp inlined, commander external)
pnpm test      # vitest
pnpm lint      # biome check .
node dist/bin/motrix.js --help
```

The build is self-contained: `tsup`'s `noExternal: [/^@motrix\//]` inlines
`@motrix/mdxp` into the bundle, so the artifact runs without a
`node_modules/@motrix/mdxp`. `commander` stays a normal runtime dependency,
installed by npm on `npm i -g @motrix/cli`.

## Publishing

Releases go to npm as `@motrix/cli` (public). `prepublishOnly` runs `pnpm build`
so the gitignored `dist/` is regenerated into the tarball. `files` ships `dist`,
`SKILL.md` (consumed at runtime by `motrix skill install` / `path`), and
`README.md`.

```bash
npm publish --dry-run   # inspect the tarball first
npm publish             # public release
```

## License

MIT © Motrix
