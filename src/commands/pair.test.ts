import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FetchLike } from '../client'
import { tokenForEndpoint } from '../credentials'
import { CliError, EXIT } from '../errors'
import { type PairContext, runPair } from './pair'

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/** A fetch that answers /mdxp/pair/request once, then walks the poll script. */
function makeFetch(opts: {
  request?: Response
  requestThrows?: boolean
  pollScript?: Array<{ status: string; token?: string }>
}): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = []
  let pollIdx = 0
  const fetchImpl = (async (url: string) => {
    calls.push(url)
    if (url.includes('/mdxp/pair/request')) {
      if (opts.requestThrows) throw new Error('ECONNREFUSED')
      return (
        opts.request ??
        jsonResponse(200, {
          requestId: 'req-1',
          userCode: 'WXYZ-2345',
          verificationUri: 'http://127.0.0.1:16801/',
          expiresAt: 9_000_000,
          interval: 2,
        })
      )
    }
    // poll
    const step = opts.pollScript?.[pollIdx] ?? { status: 'pending' }
    pollIdx = Math.min(pollIdx + 1, (opts.pollScript?.length ?? 1) - 1)
    return jsonResponse(200, step)
  }) as unknown as FetchLike
  return { fetchImpl, calls }
}

describe('runPair', () => {
  let dir: string
  let credsPath: string
  let devIdPath: string
  let out: string[]
  let errOut: string[]

  function ctx(
    fetchImpl: FetchLike,
    over: Partial<PairContext> = {}
  ): PairContext {
    return {
      baseUrl: 'http://127.0.0.1:16801',
      stdout: { write: (s: string) => out.push(s), isTTY: true },
      stderr: { write: (s: string) => errOut.push(s), isTTY: true },
      fetchImpl,
      sleep: async () => {},
      now: () => 1000,
      credentialsPath: credsPath,
      deviceIdPath: devIdPath,
      clientVersion: '1.0.0',
      hostName: 'testhost',
      ...over,
    }
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'motrix-pair-'))
    credsPath = join(dir, 'credentials.json')
    devIdPath = join(dir, 'cli-device-ids.json')
    out = []
    errOut = []
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('requests, prints the code, polls to approval, and stores the token', async () => {
    const { fetchImpl } = makeFetch({
      pollScript: [
        { status: 'pending' },
        { status: 'approved', token: 'issued-token' },
      ],
    })
    await runPair({}, ctx(fetchImpl))

    // The verification code is on STDERR (human channel), not stdout.
    expect(errOut.join('')).toContain('WXYZ-2345')
    expect(await tokenForEndpoint('http://127.0.0.1:16801', credsPath)).toBe(
      'issued-token'
    )
  })

  it('prints the code (on stderr) without a URL line when the server omits verificationUri', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes('/request')) {
        return jsonResponse(200, {
          requestId: 'r',
          userCode: 'AAAA-BBBB',
          expiresAt: 9_000_000,
          // no verificationUri — the server doesn't know its approval-UI URL
        })
      }
      return jsonResponse(200, { status: 'approved', token: 't' })
    }) as unknown as FetchLike
    await runPair({}, ctx(fetchImpl))
    const prompt = errOut.join('')
    expect(prompt).toContain('AAAA-BBBB')
    expect(prompt).toContain('Approve this pairing in Motrix')
    // no misleading link in the prompt (the bridge does not serve a UI)
    expect(prompt).not.toContain('http')
  })

  it('--json: stdout is a single JSON value with no human text (agent contract)', async () => {
    const { fetchImpl } = makeFetch({
      pollScript: [{ status: 'approved', token: 'tok' }],
    })
    await runPair({}, ctx(fetchImpl, { json: true }))
    const stdout = out.join('').trim()
    expect(JSON.parse(stdout)).toEqual({
      paired: true,
      endpoint: 'http://127.0.0.1:16801',
    })
    expect(stdout).not.toContain('Approve')
    expect(stdout).not.toContain('Verification')
    // the human prompt + code went to stderr
    expect(errOut.join('')).toContain('WXYZ-2345')
  })

  it('non-TTY stdout is JSON even without --json', async () => {
    const { fetchImpl } = makeFetch({
      pollScript: [{ status: 'approved', token: 'tok' }],
    })
    await runPair(
      {},
      ctx(fetchImpl, {
        stdout: { write: (s: string) => out.push(s), isTTY: false },
      })
    )
    expect(JSON.parse(out.join('').trim())).toMatchObject({ paired: true })
  })

  it('polls via POST with the requestId in the body (not the URL)', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init })
      if (url.includes('/request')) {
        return jsonResponse(200, {
          requestId: 'req-xyz',
          userCode: 'AAAA-BBBB',
          expiresAt: 9_000_000,
        })
      }
      return jsonResponse(200, { status: 'approved', token: 't' })
    }) as unknown as FetchLike
    await runPair({}, ctx(fetchImpl))
    const poll = seen.find((c) => c.url.endsWith('/mdxp/pair/poll'))
    expect(poll).toBeDefined()
    expect(poll?.init?.method).toBe('POST')
    expect(String(poll?.init?.body)).toContain('req-xyz')
    // requestId must NOT be in the URL
    expect(poll?.url).not.toContain('req-xyz')
  })

  it('uses the client name in the request body', async () => {
    let bodySeen = ''
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes('/request')) {
        bodySeen = String(init?.body)
        return jsonResponse(200, {
          requestId: 'r',
          userCode: 'AAAA-BBBB',
          verificationUri: 'http://x/',
          expiresAt: 9_000_000,
        })
      }
      return jsonResponse(200, { status: 'approved', token: 't' })
    }) as unknown as FetchLike
    await runPair({ name: 'My Agent' }, ctx(fetchImpl))
    expect(bodySeen).toContain('My Agent')
  })

  it('submits a persisted deviceId in the pair request body', async () => {
    let bodySeen = ''
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes('/request')) {
        bodySeen = String(init?.body)
        return jsonResponse(200, {
          requestId: 'r',
          userCode: 'AAAA-BBBB',
          expiresAt: 9_000_000,
        })
      }
      return jsonResponse(200, { status: 'approved', token: 't' })
    }) as unknown as FetchLike
    await runPair({}, ctx(fetchImpl))
    const deviceId = JSON.parse(bodySeen).deviceId
    expect(deviceId).toMatch(/^[A-Za-z0-9_-]{16,}$/)
  })

  it('reuses the same deviceId across re-pairs (so the bridge can rotate)', async () => {
    const bodies: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes('/request')) {
        bodies.push(String(init?.body))
        return jsonResponse(200, {
          requestId: 'r',
          userCode: 'AAAA-BBBB',
          expiresAt: 9_000_000,
        })
      }
      return jsonResponse(200, { status: 'approved', token: 't' })
    }) as unknown as FetchLike
    await runPair({}, ctx(fetchImpl))
    await runPair({}, ctx(fetchImpl))
    const first = JSON.parse(bodies[0]).deviceId
    const second = JSON.parse(bodies[1]).deviceId
    expect(first).toMatch(/^[A-Za-z0-9_-]{16,}$/)
    expect(second).toBe(first)
  })

  it('exits AUTH when the user denies', async () => {
    const { fetchImpl } = makeFetch({ pollScript: [{ status: 'denied' }] })
    const err = await runPair({}, ctx(fetchImpl)).catch((e) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).exitCode).toBe(EXIT.AUTH)
  })

  it('exits SERVER when the request expires', async () => {
    const { fetchImpl } = makeFetch({ pollScript: [{ status: 'expired' }] })
    const err = await runPair({}, ctx(fetchImpl)).catch((e) => e)
    expect((err as CliError).exitCode).toBe(EXIT.SERVER)
  })

  it('exits SERVER on a rate-limited request', async () => {
    const { fetchImpl } = makeFetch({ request: jsonResponse(429, {}) })
    const err = await runPair({}, ctx(fetchImpl)).catch((e) => e)
    expect((err as CliError).exitCode).toBe(EXIT.SERVER)
  })

  it('exits NETWORK when the bridge is unreachable', async () => {
    const { fetchImpl } = makeFetch({ requestThrows: true })
    const err = await runPair({}, ctx(fetchImpl)).catch((e) => e)
    expect((err as CliError).exitCode).toBe(EXIT.NETWORK)
  })

  it('times out (SERVER) when the request is already past expiry', async () => {
    const { fetchImpl } = makeFetch({
      request: jsonResponse(200, {
        requestId: 'r',
        userCode: 'AAAA-BBBB',
        verificationUri: 'http://x/',
        expiresAt: 500, // already < now()=1000
      }),
    })
    const err = await runPair({}, ctx(fetchImpl)).catch((e) => e)
    expect((err as CliError).exitCode).toBe(EXIT.SERVER)
    expect((err as CliError).message).toContain('timed out')
  })
})
