import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { EXIT } from '../errors'
import { defaultProbeBridge, isValidPort, type OpenDeps, runOpen } from './open'

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))

const READY = 'http://127.0.0.1:16800'

function deps(over: Partial<OpenDeps> = {}): OpenDeps {
  return {
    platform: 'darwin',
    spawnOpener: vi.fn().mockResolvedValue({ code: 0 }),
    probeBridge: vi.fn().mockResolvedValue(null),
    sleep: vi.fn().mockResolvedValue(undefined),
    now: vi.fn().mockReturnValue(0),
    ...over,
  }
}

describe('runOpen', () => {
  it('rejects a remote --endpoint without probing or launching', async () => {
    const d = deps()
    const r = await runOpen({ endpoint: 'http://nas.local:16801' }, d)
    expect(r).toMatchObject({
      ok: false,
      reason: 'remote_endpoint',
      exitCode: EXIT.USAGE,
    })
    expect(d.spawnOpener).not.toHaveBeenCalled()
    expect(d.probeBridge).not.toHaveBeenCalled()
  })

  it('reports already-running and does not wait when the bridge is up', async () => {
    const d = deps({ probeBridge: vi.fn().mockResolvedValue(READY) })
    const r = await runOpen({}, d)
    expect(r).toMatchObject({
      ok: true,
      alreadyRunning: true,
      launched: false,
      endpoint: READY,
      exitCode: EXIT.OK,
    })
    // opener still fired (best-effort focus), but we never slept/waited
    expect(d.spawnOpener).toHaveBeenCalledTimes(1)
    expect(d.sleep).not.toHaveBeenCalled()
  })

  it('ignores an opener failure when Motrix is already running', async () => {
    const d = deps({
      probeBridge: vi.fn().mockResolvedValue(READY),
      spawnOpener: vi.fn().mockResolvedValue({ code: 1 }),
    })
    const r = await runOpen({}, d)
    expect(r.ok).toBe(true)
    expect(r.alreadyRunning).toBe(true)
  })

  it('launches then succeeds once the bridge comes up', async () => {
    const d = deps({
      probeBridge: vi
        .fn()
        .mockResolvedValueOnce(null) // pre-launch probe
        .mockResolvedValueOnce(null) // poll #1
        .mockResolvedValueOnce(READY), // poll #2
      now: vi.fn().mockReturnValueOnce(0).mockReturnValue(500),
    })
    const r = await runOpen({}, d)
    expect(r).toMatchObject({
      ok: true,
      alreadyRunning: false,
      launched: true,
      endpoint: READY,
      exitCode: EXIT.OK,
      waitedMs: 500,
    })
    expect(d.sleep).toHaveBeenCalled()
  })

  it('returns not_installed (exit 6) when the opener exits non-zero', async () => {
    const d = deps({ spawnOpener: vi.fn().mockResolvedValue({ code: 1 }) })
    const r = await runOpen({}, d)
    expect(r).toMatchObject({
      ok: false,
      reason: 'not_installed',
      exitCode: EXIT.NOT_INSTALLED,
    })
    expect(r.message).toContain('https://motrix.app')
  })

  it('returns opener_missing (exit 3) when the opener cannot be spawned', async () => {
    const err = Object.assign(new Error('spawn xdg-open ENOENT'), {
      code: 'ENOENT',
    })
    const d = deps({
      platform: 'linux',
      spawnOpener: vi.fn().mockResolvedValue({ code: null, spawnError: err }),
    })
    const r = await runOpen({}, d)
    expect(r).toMatchObject({
      ok: false,
      reason: 'opener_missing',
      exitCode: EXIT.NETWORK,
    })
  })

  it('times out (exit 3) if the bridge never comes up', async () => {
    const d = deps({
      probeBridge: vi.fn().mockResolvedValue(null),
      now: vi
        .fn()
        .mockReturnValueOnce(0) // start
        .mockReturnValueOnce(0) // poll #1 elapsed check
        .mockReturnValueOnce(1000) // poll #2 elapsed check → >= timeout
        .mockReturnValue(1000), // waitedMs
    })
    const r = await runOpen({ timeout: 1000 }, d)
    expect(r).toMatchObject({
      ok: false,
      reason: 'launch_timeout',
      exitCode: EXIT.NETWORK,
      waitedMs: 1000,
    })
  })
})

describe('defaultProbeBridge', () => {
  it('resolves to null when endpoint.json is missing', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'))
    await expect(defaultProbeBridge()).resolves.toBeNull()
  })

  it('resolves to null when endpoint.json content is the literal null', async () => {
    vi.mocked(readFile).mockResolvedValue('null')
    await expect(defaultProbeBridge()).resolves.toBeNull()
  })

  it('resolves to null when endpoint.json is malformed JSON', async () => {
    vi.mocked(readFile).mockResolvedValue('{ not json')
    await expect(defaultProbeBridge()).resolves.toBeNull()
  })

  it('resolves to null when the port is invalid', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ port: 70000, pid: 1 })
    )
    await expect(defaultProbeBridge()).resolves.toBeNull()
  })

  it('resolves to null when the pid is stale', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ port: 16800, pid: 2147483646 })
    )
    await expect(defaultProbeBridge()).resolves.toBeNull()
  })
})

describe('isValidPort', () => {
  it('accepts a real port', () => {
    expect(isValidPort(16800)).toBe(true)
  })

  it('accepts the lowest valid port', () => {
    expect(isValidPort(1)).toBe(true)
  })

  it('accepts the highest valid port', () => {
    expect(isValidPort(65535)).toBe(true)
  })

  it('rejects 0', () => {
    expect(isValidPort(0)).toBe(false)
  })

  it('rejects a negative port', () => {
    expect(isValidPort(-1)).toBe(false)
  })

  it('rejects a port above 65535', () => {
    expect(isValidPort(70000)).toBe(false)
  })

  it('rejects one past the highest valid port', () => {
    expect(isValidPort(65536)).toBe(false)
  })

  it('rejects a non-integer port', () => {
    expect(isValidPort(8080.5)).toBe(false)
  })

  it('rejects NaN', () => {
    expect(isValidPort(Number.NaN)).toBe(false)
  })

  it('rejects undefined', () => {
    expect(isValidPort(undefined)).toBe(false)
  })

  it('rejects a stringified port', () => {
    expect(isValidPort('16800')).toBe(false)
  })
})
