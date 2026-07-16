import { describe, expect, it, vi } from 'vitest'
import { rpcCall } from './client'
import { CliError, EXIT } from './errors'

const endpoint = { baseUrl: 'http://127.0.0.1:16801', token: 'tok' }

function fakeResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as unknown as Response
}

describe('rpcCall', () => {
  it('POSTs to /mdxp with a Bearer header + JSON-RPC envelope', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        fakeResponse(200, { jsonrpc: '2.0', id: 1, result: { ok: true } })
      )
    await rpcCall(endpoint, 'task/list', { limit: 5 }, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:16801/mdxp')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer tok')
    const sent = JSON.parse(init.body)
    expect(sent).toMatchObject({
      jsonrpc: '2.0',
      method: 'task/list',
      params: { limit: 5 },
    })
  })

  it('returns the JSON-RPC result on success', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        fakeResponse(200, { jsonrpc: '2.0', id: 1, result: { total: 3 } })
      )
    const result = await rpcCall(endpoint, 'stats/get', {}, fetchImpl)
    expect(result).toEqual({ total: 3 })
  })

  it('maps a connection failure to EXIT.NETWORK', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(
      rpcCall(endpoint, 'task/list', {}, fetchImpl)
    ).rejects.toMatchObject({ exitCode: EXIT.NETWORK })
  })

  it('maps HTTP 401 to EXIT.AUTH', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      fakeResponse(401, {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32003, message: 'unauthorized' },
      })
    )
    await expect(
      rpcCall(endpoint, 'task/list', {}, fetchImpl)
    ).rejects.toMatchObject({ exitCode: EXIT.AUTH })
  })

  it('maps HTTP 403 to EXIT.AUTH', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(fakeResponse(403, { jsonrpc: '2.0', id: 1 }))
    await expect(
      rpcCall(endpoint, 'task/list', {}, fetchImpl)
    ).rejects.toMatchObject({ exitCode: EXIT.AUTH })
  })

  it('maps a JSON-RPC error body to EXIT.SERVER', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      fakeResponse(400, {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32602, message: 'invalid params' },
      })
    )
    const err = (await rpcCall(endpoint, 'task/list', {}, fetchImpl).catch(
      (e) => e
    )) as CliError
    expect(err).toBeInstanceOf(CliError)
    expect(err.exitCode).toBe(EXIT.SERVER)
    expect(err.message).toContain('invalid params')
  })

  it('turns JSON-RPC -32601 (method not found) into a friendly upgrade hint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      fakeResponse(200, {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'Method not found' },
      })
    )
    const err = (await rpcCall(endpoint, 'task/list', {}, fetchImpl).catch(
      (e) => e
    )) as CliError
    expect(err).toBeInstanceOf(CliError)
    expect(err.exitCode).toBe(EXIT.SERVER)
    // Actionable, not the raw "Method not found": names the method + points at
    // a version mismatch between the app and the CLI.
    expect(err.message).toContain('task/list')
    expect(err.message).toMatch(/update motrix/i)
    // Machine consumers (--json) can still branch on the JSON-RPC code.
    expect((err.data as { code: number }).code).toBe(-32601)
  })

  it('turns HTTP 404 into a friendly no-bridge / upgrade hint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(404, 'Not Found'))
    const err = (await rpcCall(endpoint, 'task/list', {}, fetchImpl).catch(
      (e) => e
    )) as CliError
    expect(err).toBeInstanceOf(CliError)
    expect(err.exitCode).toBe(EXIT.SERVER)
    expect(err.message).toMatch(/bridge/i)
    expect(err.message).toMatch(/404/)
  })
})
