import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OWN_NAME = '@motrix/cli'
const MAX_WALK = 5

/**
 * This package's own version, found by walking upward from the module
 * location to the nearest package.json named `@motrix/cli`. Depth-independent
 * on purpose: the dev entry runs from `src/**` and the bundle from
 * `dist/bin/motrix.js`, both inside the package root, where `package.json`
 * ships via `files` (tsup does not inline it). Returns null when no own
 * package.json is found — an install too broken to describe itself.
 */
export function readOwnVersion(startDir?: string): string | null {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < MAX_WALK; i++) {
    try {
      const raw = readFileSync(join(dir, 'package.json'), 'utf-8')
      const pkg = JSON.parse(raw) as { name?: string; version?: string }
      if (pkg.name === OWN_NAME && typeof pkg.version === 'string') {
        return pkg.version
      }
    } catch {
      // not here (or unreadable) — keep walking up
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
