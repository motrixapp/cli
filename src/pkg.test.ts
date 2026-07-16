import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readOwnVersion } from './pkg'

/** A throwaway dir tree: package.json at the root, start dir `depth` below. */
function makePkgTree(
  pkgJson: unknown,
  depth: string[]
): { root: string; start: string } {
  const root = mkdtempSync(join(tmpdir(), 'motrix-pkg-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkgJson))
  const start = join(root, ...depth)
  mkdirSync(start, { recursive: true })
  return { root, start }
}

describe('readOwnVersion', () => {
  it('finds the version from a dist-style depth (dist/bin)', () => {
    const { start } = makePkgTree({ name: '@motrix/cli', version: '9.9.9' }, [
      'dist',
      'bin',
    ])
    expect(readOwnVersion(start)).toBe('9.9.9')
  })

  it('finds the version from a src-style depth (src/commands)', () => {
    const { start } = makePkgTree({ name: '@motrix/cli', version: '1.2.3' }, [
      'src',
      'commands',
    ])
    expect(readOwnVersion(start)).toBe('1.2.3')
  })

  it('skips package.json files belonging to other packages', () => {
    const { root, start } = makePkgTree(
      { name: '@motrix/cli', version: '2.0.0' },
      ['node_modules', 'other', 'dist']
    )
    writeFileSync(
      join(root, 'node_modules', 'other', 'package.json'),
      JSON.stringify({ name: 'other', version: '0.0.1' })
    )
    expect(readOwnVersion(start)).toBe('2.0.0')
  })

  it('returns null when nothing matches within the walk bound', () => {
    const root = mkdtempSync(join(tmpdir(), 'motrix-pkg-'))
    const start = join(root, 'a', 'b')
    mkdirSync(start, { recursive: true })
    expect(readOwnVersion(start)).toBe(null)
  })

  it("resolves this repo's own version with no argument", () => {
    const expected = (
      JSON.parse(
        readFileSync(join(process.cwd(), 'package.json'), 'utf-8')
      ) as { version: string }
    ).version
    expect(readOwnVersion()).toBe(expected)
  })
})
