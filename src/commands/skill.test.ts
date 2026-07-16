import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runSkillInstall, runSkillPath, skillPath } from './skill'

describe('skillPath', () => {
  it('resolves to SKILL.md at the package root', () => {
    expect(skillPath().endsWith('SKILL.md')).toBe(true)
  })
})

describe('runSkillPath', () => {
  it('prints the resolved path', () => {
    const out: string[] = []
    runSkillPath({
      stdout: { write: (s: string) => out.push(s) },
      source: '/x/SKILL.md',
    })
    expect(out.join('')).toContain('/x/SKILL.md')
  })
})

describe('runSkillInstall', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'motrix-skill-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('copies SKILL.md into <dir>/motrix/SKILL.md', async () => {
    const src = join(dir, 'src-SKILL.md')
    await writeFile(src, '# Motrix skill\n', 'utf-8')
    const installRoot = join(dir, 'skills')
    const out: string[] = []
    await runSkillInstall(installRoot, {
      stdout: { write: (s: string) => out.push(s) },
      source: src,
    })
    const dest = join(installRoot, 'motrix', 'SKILL.md')
    expect(await readFile(dest, 'utf-8')).toContain('# Motrix skill')
    expect(out.join('')).toContain(dest)
  })

  it('defaults to a Claude skills dir when no dir is given', async () => {
    const src = join(dir, 'src-SKILL.md')
    await writeFile(src, 'x', 'utf-8')
    const installRoot = join(dir, 'default-skills')
    await runSkillInstall(undefined, {
      stdout: { write: () => {} },
      source: src,
      defaultDir: installRoot,
    })
    expect(
      await readFile(join(installRoot, 'motrix', 'SKILL.md'), 'utf-8')
    ).toBe('x')
  })
})
