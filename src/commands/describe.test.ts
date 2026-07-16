import { describe, expect, it } from 'vitest'
import { runDescribe } from './describe'

function capture(json?: boolean, isTTY = false): string {
  const out: string[] = []
  runDescribe({ stdout: { write: (s: string) => out.push(s), isTTY }, json })
  return out.join('')
}

describe('runDescribe', () => {
  it('emits a valid JSON tool catalog with --json', () => {
    const catalog = JSON.parse(capture(true)) as Array<{
      name: string
      description: string
      inputSchema: unknown
      outputSchema: unknown
    }>
    expect(Array.isArray(catalog)).toBe(true)
    expect(catalog.length).toBeGreaterThanOrEqual(8)
    for (const tool of catalog) {
      expect(typeof tool.name).toBe('string')
      expect(typeof tool.description).toBe('string')
      expect(tool.inputSchema).toBeTypeOf('object')
      expect(tool.outputSchema).toBeTypeOf('object')
    }
    const names = catalog.map((t) => t.name)
    expect(names).toContain('task/list')
    expect(names).toContain('download/add')
    // handshake/meta methods are not agent-facing
    expect(names).not.toContain('motrix/initialize')
    expect(names).not.toContain('download/submit')
  })

  it('emits JSON when piped (non-TTY) even without --json', () => {
    expect(Array.isArray(JSON.parse(capture(undefined, false)))).toBe(true)
  })

  it('emits a human summary on a TTY (not JSON)', () => {
    const text = capture(false, true)
    expect(text).toContain('tool catalog')
    expect(text).toContain('task/list')
    expect(() => JSON.parse(text)).toThrow()
  })
})
