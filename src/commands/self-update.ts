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

/** A global install can be slow (network + extraction), so it gets a generous
 *  bound; a `--version` probe should return near-instantly. Both exist so a
 *  hung subprocess can't make self-update hang forever (it would otherwise
 *  never reach the state-observation and recovery branches). */
const INSTALL_TIMEOUT_MS = 300_000
const CHECK_TIMEOUT_MS = 15_000

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
    // We can't even read our own package.json, so we don't know which manager
    // installed us. Deliberately DON'T hand back a runnable `npm i -g`: an
    // agent treats `manualCommand` as an instruction, and running npm for a
    // pnpm/yarn/bun install creates a second, PATH-shadowing copy.
    return {
      ok: false,
      exitCode: EXIT.SELF_UPDATE_FAILED,
      changed: false,
      reason: 'unknown-install',
      message:
        'cannot determine the installed version — reinstall with the package ' +
        'manager you originally used (npm, pnpm, yarn, bun, or volta).',
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
    // For a genuinely unknown source we must NOT present npm as THE fix — and
    // must not put a runnable npm command in `manualCommand` either: an agent
    // treats that field as an instruction, and `npm i -g` for a pnpm/yarn/bun
    // install creates a second, PATH-shadowing copy — the exact failure this
    // whole command exists to prevent. Point the user at their own manager.
    const message =
      source.kind === 'unknown'
        ? `${source.reason} — update it with the same tool you used to install it ` +
          `(npm, pnpm, yarn, bun, or volta). Running \`npm i -g\` blindly may ` +
          `create a second, PATH-shadowing copy.`
        : `${source.reason}. You can run it manually: ${source.manualCommand}`
    return {
      ok: false,
      exitCode: EXIT.SELF_UPDATE_FAILED,
      changed: false,
      reason,
      // Only ephemeral runs (npx/dlx/bunx) and checkout carry a safe, runnable
      // command; `unknown` deliberately carries none.
      manualCommand:
        source.kind === 'unknown' ? undefined : source.manualCommand,
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
    timeoutMs: INSTALL_TIMEOUT_MS,
  })
  // A rollback to `from` is only safe to HAND BACK when we bound the install
  // root (npm): for pnpm/yarn/bun/volta we can't prove `<pm> add -g @from`
  // targets the tree we run from, so a runnable rollback could downgrade — or
  // shadow — a different install. When unbound we give advisory prose instead.
  const rollback =
    source.kind === 'npm-global' && source.globalRoot
      ? installArgsFor(source.kind, `${OWN_PACKAGE}@${from}`).join(' ')
      : null
  if (inst.code !== 0) {
    const output = `${inst.stdout}${inst.stderr}`.trim()
    const eaccesHint = /EACCES|EPERM/.test(inst.stderr)
      ? '\nPermission denied on the global directory. Do NOT use sudo — fix the npm prefix instead: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally'
      : ''
    const exitDesc = inst.timedOut
      ? `timed out after ${Math.round(INSTALL_TIMEOUT_MS / 1000)}s`
      : inst.code === null
        ? `spawn error (${inst.spawnError?.code ?? 'unknown'})`
        : `exit ${inst.code}`
    const prefix = `installer failed (${exitDesc})${output ? `:\n${output}` : ''}${eaccesHint}`
    // A non-zero exit does NOT prove the tree is untouched — a package manager
    // can replace files and then fail (lifecycle script, disk, dep resolution).
    // Observe what is actually installed before claiming anything about state.
    const observed = await observeInstalledVersion(source, ctx)
    if (observed === to) {
      // The target is live despite the error — treat as success, but surface it.
      return {
        ok: true,
        exitCode: EXIT.OK,
        changed: true,
        from,
        to,
        method: source.kind,
        command,
        warning: `${prefix}\n…but ${OWN_PACKAGE} ${to} is now active`,
        message: `Updated ${OWN_PACKAGE} ${from} → ${to} (${source.kind}), with installer warnings`,
      }
    }
    if (observed === from) {
      // Old version still intact — safe to retry the forward install.
      return {
        ok: false,
        exitCode: EXIT.SELF_UPDATE_FAILED,
        changed: false,
        reason: 'install-failed',
        from,
        to,
        method: source.kind,
        manualCommand: command,
        message: `${prefix}\nYour existing ${from} is intact. Retry: ${command}`,
      }
    }
    // Indeterminate: could not confirm `from` is still runnable, so the tree
    // may be partially updated or broken.
    const recovery = rollback
      ? ` Check \`motrix --version\`; to restore ${from}, run: ${rollback}`
      : ` Check \`motrix --version\` and reinstall ${from} with the package manager you use.`
    return {
      ok: false,
      exitCode: EXIT.SELF_UPDATE_FAILED,
      changed: true,
      reason: 'install-failed',
      from,
      to,
      method: source.kind,
      manualCommand: rollback ?? undefined,
      message:
        `${prefix}\n${OWN_PACKAGE} could not be confirmed afterwards (now reports ` +
        `${observed ?? 'nothing'}); it may be partially updated.${recovery}`,
    }
  }

  const verified = await verifyInstall(source, to, ctx)
  if (!verified.ok) {
    // The installer exited 0, so the global tree is ALREADY mutated — report
    // that honestly (`changed: true`) rather than implying nothing happened.
    // We do NOT auto-rollback: verification can fail on a perfectly good
    // install (e.g. a stale entry-path assumption or a shadow), and downgrading
    // a healthy install — plus a second fallible mutation — is worse than
    // surfacing the state. A runnable rollback command is offered only when the
    // root is bound (npm); otherwise the recovery is advisory (an unbound
    // rollback could hit a different tree).
    const recovery = rollback
      ? ` to restore ${from}, run: ${rollback}`
      : ` if it still shows ${from}, the update likely reached a different installation — reinstall ${to} with the package manager you use.`
    return {
      ok: false,
      exitCode: EXIT.SELF_UPDATE_FAILED,
      changed: true,
      reason: 'verify-failed',
      from,
      to,
      method: source.kind,
      command,
      manualCommand: rollback ?? undefined,
      message:
        `${verified.detail}. The installer reported success but the result could ` +
        `not be verified — ${OWN_PACKAGE} may now be at ${to} or in a broken ` +
        `state. Check \`motrix --version\`;${recovery}`,
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
 * Confirm the update reached the installation the user actually runs.
 *
 * For `npm-global` we bound the global root to the running entry at detection
 * (realpath containment), so the entry inside THAT root is provably the tree
 * we set out to update — and immune to PATH shadowing. For every other kind we
 * cannot prove which tree the PATH package manager wrote to (e.g. a second
 * pnpm with a different global root), so we verify the OUTCOME the user gets:
 * what `motrix` on PATH reports now. A mismatch there is a FAILURE, not a
 * warning — a caller must not read exit 0 when its `motrix` still runs the old
 * version. "Nothing named `motrix` on PATH" is treated as UNVERIFIABLE (also a
 * failure): with an unbound root and no PATH entry we have no evidence the
 * update reached the install this command was launched from, so we must not
 * claim success — the message says it is likely fine and how to confirm.
 */
async function verifyInstall(
  source: InstallSource & { executable: true },
  expected: string,
  ctx: SelfUpdateCtx
): Promise<VerifyOutcome> {
  if (source.kind === 'npm-global' && source.globalRoot) {
    const entry = join(
      source.globalRoot,
      '@motrix',
      'cli',
      'dist',
      'bin',
      'motrix.js'
    )
    const got = await runVersion(ctx, ctx.execPath, [entry, '--version'])
    if (got !== expected) {
      return {
        ok: false,
        detail:
          got == null
            ? `the updated entry did not run (${entry})`
            : `the updated entry reports ${got}, expected ${expected}`,
      }
    }
    // The bound tree is at `expected`. If PATH resolves `motrix` elsewhere,
    // that is a shadow, not a failure — surface it as a non-fatal warning.
    const bin = await ctx.whichBin('motrix')
    if (bin) {
      const onPath = await runVersion(ctx, bin, ['--version'])
      if (onPath !== expected) {
        return {
          ok: true,
          warning: `updated your npm-global install to ${expected}, but \`motrix\` on PATH (${bin}) reports ${onPath ?? 'an error'} — another install is shadowing it`,
        }
      }
    }
    return { ok: true }
  }

  const bin = await ctx.whichBin('motrix')
  if (!bin) {
    return {
      ok: false,
      detail: `installed ${expected}, but could not verify it — \`motrix\` is not on PATH in this shell (open a new shell and run \`motrix --version\`)`,
    }
  }
  const onPath = await runVersion(ctx, bin, ['--version'])
  if (onPath === expected) return { ok: true }
  return {
    ok: false,
    detail: `\`motrix\` on PATH (${bin}) reports ${onPath ?? 'an error'}, not ${expected} — the update may have targeted a different installation`,
  }
}

/** The version the installation we run currently reports, or null if it can't
 *  be determined — the bound npm entry when known, else `motrix` on PATH. */
async function observeInstalledVersion(
  source: InstallSource & { executable: true },
  ctx: SelfUpdateCtx
): Promise<string | null> {
  if (source.kind === 'npm-global' && source.globalRoot) {
    const entry = join(
      source.globalRoot,
      '@motrix',
      'cli',
      'dist',
      'bin',
      'motrix.js'
    )
    return runVersion(ctx, ctx.execPath, [entry, '--version'])
  }
  const bin = await ctx.whichBin('motrix')
  return bin ? runVersion(ctx, bin, ['--version']) : null
}

/** Run `<cmd> <args>` and return trimmed stdout on exit 0, else null. */
async function runVersion(
  ctx: SelfUpdateCtx,
  cmd: string,
  args: string[]
): Promise<string | null> {
  const res = await ctx.runCommand(cmd, args, {
    cwd: ctx.neutralDir,
    timeoutMs: CHECK_TIMEOUT_MS,
  })
  return res.code === 0 ? res.stdout.trim() : null
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
