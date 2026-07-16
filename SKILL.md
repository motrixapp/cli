---
name: motrix
description: Use when you need to drive a Motrix download manager from the command line — list/inspect downloads, add downloads (URL, magnet, or torrent), pause/resume/remove tasks, watch live progress, or read aggregate stats. Works against a local desktop Motrix (auto-discovered) or a remote/headless server (via `--endpoint` + a paired token).
---

# Motrix CLI

`motrix` is a command-line client for the Motrix download manager, built for both humans and AI agents. It speaks MDXP (JSON-RPC 2.0) to a running Motrix over a unary `POST /mdxp` transport.

## When to use

Reach for `motrix` whenever the task involves a Motrix download: enumerating or filtering tasks, starting a download, controlling a task's lifecycle, or streaming progress. If Motrix isn't running (or unreachable), commands fail fast with exit code `3` — surface that rather than retrying blindly. If Motrix isn't running, run `motrix open` first to launch the local desktop app (exit `6` if it isn't installed), then retry.

## Setup / connection

- **Local desktop**: no setup — the CLI auto-discovers the running app via `<userData>/bridge/endpoint.json` (port + machine-owner token).
- **Remote / headless server**: run `motrix pair` once. It prints a verification code; approve it in the Motrix UI. The issued token is stored in `~/.config/motrix/credentials.json` (mode 0600) keyed by endpoint, and reused automatically by later commands.
- **Explicit overrides**: `--endpoint <url>` (e.g. `http://nas.local:16801`), `--token <token>`, or `MOTRIX_BRIDGE_TOKEN`.

## Output contract (read this first if you are an agent)

- **`--json` flag, or piped / non-TTY** → a single JSON value on stdout. This is the mode to parse.
- **Interactive TTY** → a human-readable table/summary.
- **Exit codes** — branch on these:
  - `0` ok
  - `2` usage error (bad flags/args)
  - `3` network — the bridge is down / unreachable
  - `4` auth — token missing or rejected (re-run `motrix pair`)
  - `5` server error — the bridge returned a JSON-RPC error
  - `6` not-installed — the Motrix desktop app could not be launched (`motrix open`)
  - `7` self-update failed — this environment can't self-update (npx / checkout / unknown install source) or the installer failed; don't retry, run the printed manual command instead

## Commands

```bash
motrix list [--status <s>] [--limit <n>] [--offset <n>]   # list tasks
motrix stats                                              # aggregate speeds + counts
motrix open [--timeout <ms>]                              # launch the local desktop app + wait for its bridge
motrix add <url...> --save-dir <dir> [--filename <name>]  # add http(s)/ftp download(s)
motrix add --magnet <uri> --save-dir <dir> [--select 0,2] # add a magnet
motrix add --torrent <file.torrent> --save-dir <dir>      # add a .torrent
motrix pause <taskId>                                     # pause
motrix resume <taskId>                                    # resume
motrix remove <taskId> [--delete-files]                   # remove
motrix watch [--task <id>] [--stats]                      # stream progress (NDJSON) until Ctrl-C
motrix pair [--name <label>]                              # device-code pair with a bridge
motrix describe                                           # print the MDXP tool catalog
motrix skill path | install [dir]                         # locate / install this skill
motrix self-update [target] [--dry-run]                   # update this CLI itself (exit 7 = can't update here)
```

All commands accept the global `--endpoint` / `--token` / `--json` flags.

## Discovering the exact callable surface

Run **`motrix describe --json`** for the authoritative tool catalog: each agent-callable MDXP method with its JSON-Schema (draft 2020-12) `inputSchema` and `outputSchema`. It is static (no bridge call) and always reflects the version of the protocol this CLI was built against, so it can't drift from what the commands actually send. Use it to learn precise parameter shapes instead of guessing.
