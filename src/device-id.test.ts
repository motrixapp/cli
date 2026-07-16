import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deviceIdForEndpoint, ensureDeviceId } from './device-id'

describe('device-id store', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'motrix-devid-'))
    // nested so we also exercise recursive mkdir on first write
    path = join(dir, 'bridge', 'cli-device-ids.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns null when no handle is stored for the endpoint', async () => {
    expect(await deviceIdForEndpoint('http://127.0.0.1:1', path)).toBeNull()
  })

  it('ensureDeviceId mints a base64url handle (>=16 chars) and persists it', async () => {
    const id = await ensureDeviceId('http://127.0.0.1:1', path)
    expect(id).toMatch(/^[A-Za-z0-9_-]{16,}$/)
    expect(await deviceIdForEndpoint('http://127.0.0.1:1', path)).toBe(id)
  })

  it('reuses the same handle on a second call (re-pair stability)', async () => {
    const a = await ensureDeviceId('http://127.0.0.1:1', path)
    const b = await ensureDeviceId('http://127.0.0.1:1', path)
    expect(b).toBe(a)
  })

  it('keeps independent handles per endpoint', async () => {
    const a = await ensureDeviceId('http://127.0.0.1:1', path)
    const b = await ensureDeviceId('http://127.0.0.1:2', path)
    expect(a).not.toBe(b)
  })

  it('writes the store file with 0600 permissions', async () => {
    await ensureDeviceId('http://127.0.0.1:1', path)
    const mode = (await stat(path)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  async function seed(obj: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(obj))
  }

  it('deviceIdForEndpoint returns null for a malformed stored handle', async () => {
    await seed({ 'http://127.0.0.1:1': 'short' })
    expect(await deviceIdForEndpoint('http://127.0.0.1:1', path)).toBeNull()
  })

  it('deviceIdForEndpoint returns null for a non-string stored value', async () => {
    await seed({ 'http://127.0.0.1:1': { nested: true } })
    expect(await deviceIdForEndpoint('http://127.0.0.1:1', path)).toBeNull()
  })

  it('ensureDeviceId replaces a malformed stored handle with a fresh valid one', async () => {
    await seed({ 'http://127.0.0.1:1': 'short' })
    const id = await ensureDeviceId('http://127.0.0.1:1', path)
    expect(id).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
    // overwritten + stable on the next read
    expect(await deviceIdForEndpoint('http://127.0.0.1:1', path)).toBe(id)
  })

  it('preserves other endpoints when replacing a malformed handle', async () => {
    await seed({
      'http://127.0.0.1:1': 'short',
      'http://127.0.0.1:2': 'ZGV2aWNlLWhhbmRsZS1rZWVw',
    })
    await ensureDeviceId('http://127.0.0.1:1', path)
    expect(await deviceIdForEndpoint('http://127.0.0.1:2', path)).toBe(
      'ZGV2aWNlLWhhbmRsZS1rZWVw'
    )
  })

  it('leaves no temp files behind after an atomic write', async () => {
    await ensureDeviceId('http://127.0.0.1:1', path)
    expect(await readdir(dirname(path))).toEqual(['cli-device-ids.json'])
  })
})
