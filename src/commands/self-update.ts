import { access, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
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
  /** True when the installer mutated the global tree (a new version was
   *  installed). This can be true while `ok` is false: the install succeeded
   *  but post-install verification could not confirm the result. */
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
  execPath: string
  realpath: (p: string) => Promise<string>
  runCommand: RunCommand
  /** A user-owned neutral working directory for package-manager subprocesses.
   *  NOT a shared temp dir: a global operation must not read a hostile or
   *  project-local `.npmrc`/`.yarnrc` from cwd or its ancestors (yarn walks
   *  ancestors and honors `yarn-path`; `/tmp` is world-writable on Linux).
   *  The user's own `~/.npmrc` is honored regardless of cwd, so a home dir
   *  keeps global config while denying the shared-temp injection vector. */
  neutralDir: string
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
    neutralDir: ctx.neutralDir,
  })
  if (!source.executable) {
    const reason: SelfUpdateReason =
      source.kind === 'checkout'
        ? 'unsupported-checkout'
        : source.kind === 'unknown'
          ? 'unknown-install'
          : 'unsupported-ephemeral'
    // For a genuinely unknown source we must NOT present npm as THE fix:
    // if the CLI was actually installed by another manager, `npm i -g`
    // creates a second, PATH-shadowing copy — the exact failure this whole
    // command exists to prevent. Point the user at their own manager instead.
    const message =
      source.kind === 'unknown'
        ? `${source.reason} — update it with the same tool you used to install it ` +
          `(npm, pnpm, yarn, bun, or volta). Running \`${source.manualCommand}\` ` +
          `blindly may create a second, PATH-shadowing copy.`
        : `${source.reason}. You can run it manually: ${source.manualCommand}`
    return {
      ok: false,
      exitCode: EXIT.SELF_UPDATE_FAILED,
      changed: false,
      reason,
      manualCommand: source.manualCommand,
      message,
    }
  }

  const resolved = await resolveTargetVersion(spec, {
    runCommand: ctx.runCommand,
    neutralDir: ctx.neutralDir,
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
    cwd: ctx.neutralDir,
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
    // The installer exited 0, so the global tree is ALREADY mutated — report
    // that honestly (`changed: true`) rather than implying nothing happened.
    // Recovery is a deliberate rollback to `from` via the SAME manager, not a
    // blind re-run of the forward install (which would just reproduce this
    // unverifiable state). We do NOT auto-rollback: verification can fail on a
    // perfectly good install (e.g. a stale entry-path assumption), and
    // downgrading a healthy install — plus a second fallible mutation — is
    // worse than surfacing the state and the exact command.
    const rollback = installArgsFor(source.kind, `${OWN_PACKAGE}@${from}`).join(
      ' '
    )
    return {
      ok: false,
      exitCode: EXIT.SELF_UPDATE_FAILED,
      changed: true,
      reason: 'verify-failed',
      from,
      to,
      method: source.kind,
      command,
      manualCommand: rollback,
      message:
        `${verified.detail}. The installer reported success but the result could ` +
        `not be verified — ${OWN_PACKAGE} may now be at ${to} or in a broken ` +
        `state. Check \`motrix --version\`; to restore ${from}, run: ${rollback}`,
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
      const res = await ctx.runCommand(pm, ['root', '-g'], {
        cwd: ctx.neutralDir,
      })
      root = res.code === 0 ? res.stdout.trim() || null : null
    }
    if (root) {
      const entry = join(root, '@motrix', 'cli', 'dist', 'bin', 'motrix.js')
      const res = await ctx.runCommand(ctx.execPath, [entry, '--version'], {
        cwd: ctx.neutralDir,
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
  const res = await ctx.runCommand(bin, ['--version'], { cwd: ctx.neutralDir })
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
    execPath: process.execPath,
    realpath: (p) => realpath(p),
    runCommand,
    // Home is user-owned and outside shared /tmp, so no other local user can
    // plant a hostile `.npmrc`/`.yarnrc` in cwd or an ancestor; the user's own
    // `~/.npmrc` (registry/auth) is still honored.
    neutralDir: homedir(),
    whichBin: defaultWhichBin,
  }
}
