import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  credentialsFilePath,
  loadCredentials,
  saveToken,
  tokenForEndpoint,
} from './credentials'

// Expectations are join()-built: credentialsFilePath joins with the HOST
// separator, so literal `/` strings would fail on a Windows host.
describe('credentialsFilePath', () => {
  it('lands under ~/.config/motrix by default', () => {
    expect(credentialsFilePath({}, '/home/me')).toBe(
      join('/home/me', '.config', 'motrix', 'credentials.json')
    )
  })

  it('honors XDG_CONFIG_HOME', () => {
    expect(credentialsFilePath({ XDG_CONFIG_HOME: '/cfg' }, '/home/me')).toBe(
      join('/cfg', 'motrix', 'credentials.json')
    )
  })
})

describe('credentials store', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'motrix-creds-'))
    path = join(dir, 'sub', 'credentials.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns {} when the file is absent', async () => {
    expect(await loadCredentials(path)).toEqual({})
    expect(await tokenForEndpoint('http://x', path)).toBeNull()
  })

  it('round-trips a token keyed by endpoint and creates the dir', async () => {
    await saveToken(
      'http://127.0.0.1:16801',
      { token: 'tok-a', clientName: 'CLI', pairedAt: 1 },
      path
    )
    expect(await tokenForEndpoint('http://127.0.0.1:16801', path)).toBe('tok-a')
  })

  // Windows has no POSIX permission bits (stat.mode reports 0o666); the
  // chmod call is still exercised there as a no-op by the other tests.
  it.skipIf(process.platform === 'win32')(
    'writes the file at mode 0600',
    async () => {
      await saveToken('http://x', { token: 't' }, path)
      const st = await stat(path)
      expect(st.mode & 0o777).toBe(0o600)
    }
  )

  it('normalizes a trailing slash in the endpoint key', async () => {
    await saveToken('http://nas.local:16801/', { token: 'tok-b' }, path)
    expect(await tokenForEndpoint('http://nas.local:16801', path)).toBe('tok-b')
  })

  it('keeps other endpoints when saving a new one', async () => {
    await saveToken('http://a', { token: 'ta' }, path)
    await saveToken('http://b', { token: 'tb' }, path)
    expect(await tokenForEndpoint('http://a', path)).toBe('ta')
    expect(await tokenForEndpoint('http://b', path)).toBe('tb')
  })
})
