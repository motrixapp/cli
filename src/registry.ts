import { OWN_PACKAGE } from './install-source'
import type { RunCommand } from './run-command'
import { pickHighest } from './semver'

/** A registry query should be quick; bound it so a stuck request can't hang
 *  self-update forever (the installer step gets a longer bound of its own). */
const VIEW_TIMEOUT_MS = 30_000

export type ResolveOutcome =
  | { ok: true; version: string }
  | { ok: false; reason: 'bad-target' | 'resolve-failed'; message: string }

export interface ResolveCtx {
  runCommand: RunCommand
  /** cwd for the view subprocess — a user-owned neutral dir, so neither the
   *  surrounding project's nor a hostile shared-temp `.npmrc`/lockfile can
   *  capture a global operation. */
  neutralDir: string
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
  let res = await ctx.runCommand('npm', args, {
    cwd: ctx.neutralDir,
    timeoutMs: VIEW_TIMEOUT_MS,
  })
  // `commandMissing` is normalized in run-command.ts: POSIX spawn ENOENT AND
  // win32's cmd.exe 9009. The prior `code === null` check missed win32, so a
  // pnpm-only Windows box never reached this fallback.
  if (res.commandMissing && ctx.allowPnpmFallback) {
    res = await ctx.runCommand('pnpm', args, {
      cwd: ctx.neutralDir,
      timeoutMs: VIEW_TIMEOUT_MS,
    })
  }
  if (res.commandMissing) {
    return {
      ok: false,
      reason: 'resolve-failed',
      message: `no package manager available to query the registry (tried npm${
        ctx.allowPnpmFallback ? ' and pnpm' : ''
      }) — install one or update manually`,
    }
  }
  if (res.timedOut) {
    return {
      ok: false,
      reason: 'resolve-failed',
      message: 'registry query timed out — check your network and retry',
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
