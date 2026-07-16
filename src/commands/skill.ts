import { copyFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Path to the shipped `SKILL.md`. Both the dev entry (`src/commands/skill.ts`)
 * and the bundled output (`dist/bin/motrix.js`) sit two directories under the
 * package root, where `SKILL.md` ships (via `files`), so `../../SKILL.md`
 * resolves it in both.
 */
export function skillPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'SKILL.md')
}

export interface SkillContext {
  stdout: { write(s: string): unknown; isTTY?: boolean }
  /** Override the source SKILL.md path (tests). */
  source?: string
  /** Override the default install root (tests / non-Claude agents). */
  defaultDir?: string
}

/** `motrix skill path` — print the shipped SKILL.md path so an agent/user can
 *  find it without guessing the install layout. */
export function runSkillPath(ctx: SkillContext): void {
  ctx.stdout.write(`${ctx.source ?? skillPath()}\n`)
}

/** `motrix skill install [dir]` — copy SKILL.md into an agent skill directory
 *  (default `~/.claude/skills`), namespaced under `motrix/`. */
export async function runSkillInstall(
  dir: string | undefined,
  ctx: SkillContext
): Promise<void> {
  const root = dir ?? ctx.defaultDir ?? join(homedir(), '.claude', 'skills')
  const destDir = join(root, 'motrix')
  await mkdir(destDir, { recursive: true })
  const dest = join(destDir, 'SKILL.md')
  await copyFile(ctx.source ?? skillPath(), dest)
  ctx.stdout.write(`Installed Motrix agent skill → ${dest}\n`)
}
