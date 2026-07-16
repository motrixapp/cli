import { Command, CommanderError } from 'commander'
import type { CommandIo } from './command-io'
import { type AddOpts, runAdd } from './commands/add'
import { runDescribe } from './commands/describe'
import {
  type RemoveOpts,
  runPause,
  runRemove,
  runResume,
} from './commands/lifecycle'
import { type ListOpts, runList } from './commands/list'
import { defaultOpenDeps, runOpen } from './commands/open'
import { type PairOpts, runPair } from './commands/pair'
import { defaultSelfUpdateCtx, runSelfUpdate } from './commands/self-update'
import { runSkillInstall, runSkillPath } from './commands/skill'
import { runStats } from './commands/stats'
import { runWatch, type WatchOpts } from './commands/watch'
import { discoverBaseUrl, discoverEndpoint } from './discovery'
import { CliError, EXIT, type ExitCode } from './errors'
import { wantsJson } from './output'
import { readOwnVersion } from './pkg'

interface GlobalOpts {
  endpoint?: string
  token?: string
  json?: boolean
}

/** Map a thrown value to the CLI exit code. CliError carries its own; a
 *  commander usage error → USAGE (help/version are exitCode 0 → OK); anything
 *  else is an unexpected server-side/internal failure → SERVER. */
export function exitCodeForError(err: unknown): ExitCode {
  if (err instanceof CliError) return err.exitCode
  if (err instanceof CommanderError) {
    return err.exitCode === 0 ? EXIT.OK : EXIT.USAGE
  }
  return EXIT.SERVER
}

async function ioFromGlobals(global: GlobalOpts): Promise<CommandIo> {
  const endpoint = await discoverEndpoint({
    endpoint: global.endpoint,
    token: global.token,
  })
  return { endpoint, stdout: process.stdout, json: global.json }
}

function intArg(value: string): number {
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n)) {
    throw new CommanderError(1, 'motrix.badInt', `not a number: ${value}`)
  }
  return n
}

/** Accumulator for repeatable options (e.g. `--header` given multiple times). */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value])
}

/** Build the commander program (no parsing, no side effects). */
export function buildProgram(): Command {
  const program = new Command()
  program
    .name('motrix')
    .description('Drive a local or remote Motrix download manager.')
    .version(
      readOwnVersion() ?? 'unknown',
      '-V, --version',
      'print the CLI version'
    )
    .option(
      '--endpoint <url>',
      'bridge base URL (default: auto-discovered local desktop)'
    )
    .option(
      '--token <token>',
      'bridge bearer token (default: endpoint.json or $MOTRIX_BRIDGE_TOKEN)'
    )
    .option('--json', 'emit machine-readable JSON (implied when piped)')

  program
    .command('list')
    .description('List download tasks.')
    .option('--status <status>', 'filter by status (queued, downloading, …)')
    .option('--limit <n>', 'max tasks to return', intArg)
    .option('--offset <n>', 'skip the first N tasks', intArg)
    .action(async (opts: ListOpts) => {
      const io = await ioFromGlobals(program.opts<GlobalOpts>())
      await runList(opts, io)
    })

  program
    .command('stats')
    .description('Show aggregate download stats (speeds + task counts).')
    .action(async () => {
      const io = await ioFromGlobals(program.opts<GlobalOpts>())
      await runStats(io)
    })

  program
    .command('open')
    .description(
      'Launch the local desktop Motrix and wait until its bridge is ready.'
    )
    .option(
      '--timeout <ms>',
      'ms to wait for the bridge after launching',
      intArg
    )
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

  program
    .command('pair')
    .description('Pair this CLI with a Motrix bridge via device code.')
    .option('--name <name>', 'label shown in the Motrix approval prompt')
    .action(async (opts: PairOpts) => {
      // Pairing runs BEFORE a token exists, so it resolves only the base URL
      // (no token) and talks to the REST /mdxp/pair/* routes.
      const global = program.opts<GlobalOpts>()
      const baseUrl = await discoverBaseUrl({ endpoint: global.endpoint })
      await runPair(opts, {
        baseUrl,
        stdout: process.stdout,
        stderr: process.stderr,
        json: global.json,
        clientVersion: readOwnVersion() ?? undefined,
      })
    })

  program
    .command('add')
    .description('Add a download by URL(s), --magnet, or --torrent.')
    .argument('[urls...]', 'one or more http(s)/ftp(s)/sftp URLs')
    .requiredOption('--save-dir <dir>', 'destination directory on the server')
    .option('--filename <name>', 'override the saved filename (url mode)')
    .option(
      '--header <header>',
      'repeatable "Name: Value" request header',
      collect,
      []
    )
    .option('--connections <n>', 'connections per server (1-128)', intArg)
    .option('--proxy <url>', 'proxy URL (url mode)')
    .option('--magnet <uri>', 'add a magnet link instead of URLs')
    .option('--torrent <file>', 'add a local .torrent file instead of URLs')
    .option(
      '--select <indices>',
      'comma-separated file indices (magnet/torrent)'
    )
    .action(async (urls: string[], opts: AddOpts) => {
      const io = await ioFromGlobals(program.opts<GlobalOpts>())
      await runAdd(urls, opts, io)
    })

  program
    .command('pause')
    .description('Pause a task by id (pauses all live instances).')
    .argument('<taskId>', 'public task id')
    .action(async (taskId: string) => {
      const io = await ioFromGlobals(program.opts<GlobalOpts>())
      await runPause(taskId, io)
    })

  program
    .command('resume')
    .description('Resume a paused task by id.')
    .argument('<taskId>', 'public task id')
    .action(async (taskId: string) => {
      const io = await ioFromGlobals(program.opts<GlobalOpts>())
      await runResume(taskId, io)
    })

  program
    .command('remove')
    .description('Remove a task by id, optionally deleting its files.')
    .argument('<taskId>', 'public task id')
    .option('--delete-files', 'also delete the downloaded files')
    .action(async (taskId: string, opts: RemoveOpts) => {
      const io = await ioFromGlobals(program.opts<GlobalOpts>())
      await runRemove(taskId, opts, io)
    })

  program
    .command('watch')
    .description(
      'Stream live task progress + stats (NDJSON) until interrupted.'
    )
    .option('--task <id>', 'only events for this task')
    .option('--stats', 'only $/stats events')
    .action(async (opts: WatchOpts) => {
      const io = await ioFromGlobals(program.opts<GlobalOpts>())
      // SIGINT aborts the stream → runWatch returns → clean exit 0.
      const controller = new AbortController()
      process.once('SIGINT', () => controller.abort())
      await runWatch(opts, io, { signal: controller.signal })
    })

  program
    .command('describe')
    .description(
      'Print the MDXP tool catalog (agent-callable methods + JSON schemas).'
    )
    .action(() => {
      // Static — no bridge connection; reflects the bundled mdxp surface.
      runDescribe({
        stdout: process.stdout,
        json: program.opts<GlobalOpts>().json,
      })
    })

  const skill = program
    .command('skill')
    .description('Manage the shipped agent skill (SKILL.md).')
  skill
    .command('path')
    .description('Print the shipped SKILL.md path.')
    .action(() => {
      runSkillPath({ stdout: process.stdout })
    })
  skill
    .command('install [dir]')
    .description(
      'Copy SKILL.md into an agent skill directory (default ~/.claude/skills).'
    )
    .action(async (dir: string | undefined) => {
      await runSkillInstall(dir, { stdout: process.stdout })
    })

  return program
}

/**
 * Make commander THROW a CommanderError instead of calling process.exit, so
 * `runMain`'s catch can map it to our exit-code contract. exitOverride is
 * per-command and does NOT propagate to subcommands, so a missing required
 * option on `add`/`pause`/… would otherwise commander-exit 1 instead of
 * throwing — apply it to the root AND every subcommand.
 */
export function applyExitOverride(program: Command): void {
  program.exitOverride()
  // Recurse so nested subcommands (e.g. `skill path` / `skill install`) also
  // throw instead of process.exit — same reason as the top-level commands.
  for (const sub of program.commands) applyExitOverride(sub)
}

/** Parse argv, run the matched command, and exit with the contract's code. */
export async function runMain(argv: string[]): Promise<void> {
  const program = buildProgram()
  applyExitOverride(program)
  try {
    await program.parseAsync(argv)
  } catch (err) {
    if (!(err instanceof CommanderError) || err.exitCode !== 0) {
      const message = err instanceof Error ? err.message : 'unexpected failure'
      process.stderr.write(`motrix: ${message}\n`)
    }
    process.exit(exitCodeForError(err))
  }
}
