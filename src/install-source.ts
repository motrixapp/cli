import type { RunCommand } from './run-command'

/** The npm package this CLI ships as — what a self-update reinstalls. */
export const OWN_PACKAGE = '@motrix/cli'

export type ExecutableKind =
  | 'npm-global'
  | 'pnpm-global'
  | 'yarn-global'
  | 'bun-global'
  | 'volta'

export type RefusedKind = 'npx' | 'pnpm-dlx' | 'bunx' | 'checkout' | 'unknown'

export type InstallSource =
  | { executable: true; kind: ExecutableKind; globalRoot?: string }
  | {
      executable: false
      kind: RefusedKind
      reason: string
      manualCommand: string
    }

export interface DetectCtx {
  /** process.argv[1] — the bin path the CLI was started from. */
  argv1: string
  realpath: (p: string) => Promise<string>
  env: NodeJS.ProcessEnv
  /** Used only by the final `npm root -g` probe. */
  runCommand: RunCommand
}

/** The exact installer invocation, e.g. `['pnpm','add','-g','@motrix/cli@1.2.3']`. */
export function installArgsFor(
  kind: ExecutableKind,
  packageSpec: string
): string[] {
  switch (kind) {
    case 'volta':
      return ['volta', 'install', packageSpec]
    case 'pnpm-global':
      return ['pnpm', 'add', '-g', packageSpec]
    case 'yarn-global':
      return ['yarn', 'global', 'add', packageSpec]
    case 'bun-global':
      return ['bun', 'add', '-g', packageSpec]
    case 'npm-global':
      return ['npm', 'install', '-g', packageSpec]
  }
}

const NPM_MANUAL = `npm install -g ${OWN_PACKAGE}@latest`

/**
 * Classify how this CLI was installed from the realpath of its bin. Cheap
 * synchronous path-fragment checks run first; the one subprocess probe
 * (`npm root -g`) runs last. Anything unrecognized is REFUSED — updating via
 * the wrong manager installs a second, PATH-shadowing copy, which is worse
 * than asking the user to run one command by hand (the pnpm corepack-guard
 * principle; the accident class this avoids is claude-code#28625).
 */
export async function detectInstallSource(
  ctx: DetectCtx
): Promise<InstallSource> {
  let real = ctx.argv1
  try {
    real = await ctx.realpath(ctx.argv1)
  } catch {
    // keep the unresolved path — the cascade still classifies most layouts
  }
  const p = real.replaceAll('\\', '/')

  // npm's npx cache dir is always literally `_npx` (~/.npm/_npx on POSIX,
  // %LocalAppData%/npm-cache/_npx on Windows).
  if (p.includes('/_npx/')) {
    return refused('npx', 'running via npx — a one-off copy, nothing to update')
  }
  if (p.includes('/.pnpm/_pnpx/') || p.includes('/.cache/pnpm/dlx/')) {
    return refused(
      'pnpm-dlx',
      'running via pnpm dlx — a one-off copy, nothing to update'
    )
  }
  if (p.includes('/.bun/install/cache/')) {
    return refused(
      'bunx',
      'running via bunx — a one-off copy, nothing to update'
    )
  }
  if (!p.includes('/node_modules/')) {
    return {
      executable: false,
      kind: 'checkout',
      reason: 'running from a source checkout, not an installed package',
      manualCommand: 'git pull && pnpm install && pnpm build',
    }
  }
  if (p.includes('/.volta/') || p.includes('/Volta/')) {
    return { executable: true, kind: 'volta' }
  }
  const pnpmHome = ctx.env.PNPM_HOME?.replaceAll('\\', '/')
  if (
    (pnpmHome && p.startsWith(withSlash(pnpmHome))) ||
    p.includes('/.local/share/pnpm/') ||
    p.includes('/Library/pnpm/') ||
    p.includes('/AppData/Local/pnpm/') ||
    p.includes('/.pnpm/global/')
  ) {
    return { executable: true, kind: 'pnpm-global' }
  }
  if (p.includes('/.yarn/global/')) {
    return { executable: true, kind: 'yarn-global' }
  }
  if (p.includes('/.bun/install/global/')) {
    return { executable: true, kind: 'bun-global' }
  }
  const root = await npmGlobalRoot(ctx)
  if (root && p.startsWith(withSlash(root.replaceAll('\\', '/')))) {
    return { executable: true, kind: 'npm-global', globalRoot: root }
  }
  return refused('unknown', 'could not determine how this CLI was installed')
}

function refused(kind: RefusedKind, reason: string): InstallSource {
  return { executable: false, kind, reason, manualCommand: NPM_MANUAL }
}

function withSlash(dir: string): string {
  return dir.endsWith('/') ? dir : `${dir}/`
}

/** `npm root -g`, realpath'd; null when npm is unusable or silent. */
async function npmGlobalRoot(ctx: DetectCtx): Promise<string | null> {
  const res = await ctx.runCommand('npm', ['root', '-g'])
  if (res.code !== 0) return null
  const raw = res.stdout.trim()
  if (!raw) return null
  try {
    return await ctx.realpath(raw)
  } catch {
    return raw
  }
}
