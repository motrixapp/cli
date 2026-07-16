import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runList } from './commands/list'

// End-to-end smoke: a real node:http server stubbing POST /mdxp, driven through
// the real global fetch (no injected fetchImpl) — proves the unary request
// shape + response parsing wire up against an actual socket.
let server: Server
let baseUrl: string
let lastBody: unknown

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mdxp') {
      res.writeHead(404).end()
      return
    }
    if (req.headers.authorization !== 'Bearer e2e-token') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32003, message: 'unauthorized' },
        })
      )
      return
    }
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      lastBody = JSON.parse(raw)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tasks: [
              {
                id: 'e2e-1',
                type: 'http',
                name: 'file.bin',
                status: 'downloading',
                progress: 0.25,
                bytesDone: 250,
                bytesTotal: 1000,
                speedBps: 50,
                etaSec: 15,
                saveDir: '/dl',
                error: null,
                createdAt: 0,
                finishedAt: null,
                finalPath: null,
              },
            ],
            total: 1,
          },
        })
      )
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  if (addr && typeof addr === 'object')
    baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('CLI ↔ real POST /mdxp', () => {
  it('runList fetches and emits JSON when piped (non-TTY)', async () => {
    let out = ''
    await runList(
      { status: 'downloading' },
      {
        endpoint: { baseUrl, token: 'e2e-token' },
        stdout: {
          write: (s: string) => {
            out += s
            return true
          },
          isTTY: false,
        },
      }
    )
    const parsed = JSON.parse(out)
    expect(parsed.total).toBe(1)
    expect(parsed.tasks[0].id).toBe('e2e-1')
    // request shape reached the server intact
    expect(lastBody).toMatchObject({
      jsonrpc: '2.0',
      method: 'task/list',
      params: { status: 'downloading' },
    })
  })
})
