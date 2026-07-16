import { describe, expect, it, vi } from 'vitest'
import { EXIT } from '../errors'
import { formatWatchEvent, runWatch, shouldEmit } from './watch'

const endpoint = { baseUrl: 'http://127.0.0.1:16801', token: 'tok' }

function capture(isTTY: boolean) {
  let out = ''
  return {
    stdout: {
      write: (s: string) => {
        out += s
        return true
      },
      isTTY,
    },
    get lines() {
      return out.split('\n').filter(Boolean)
    },
  }
}

function sseResponse(chunks: string[], status = 200): Response {
  const enc = new TextEncoder()
  let i = 0
  const body =
    status === 200
      ? new ReadableStream<Uint8Array>({
          pull(controller) {
            if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]))
            else controller.close()
          },
        })
      : null
  return {
    status,
    ok: status >= 200 && status < 300,
    body,
  } as unknown as Response
}

const progressFrame = (taskId: string) =>
  `event: $/task/progress\ndata: ${JSON.stringify({ taskId, phase: 'downloading', bytesDone: 1, bytesTotal: 2, speedBps: 3, etaSec: 4 })}\n\n`
const statsFrame = `event: $/stats\ndata: ${JSON.stringify({ totalDownloadSpeed: 10, totalUploadSpeed: 0, activeTasks: 1, waitingTasks: 0, stoppedTasks: 0 })}\n\n`

describe('shouldEmit', () => {
  it('--stats keeps only $/stats', () => {
    expect(shouldEmit('$/stats', {}, { stats: true })).toBe(true)
    expect(
      shouldEmit('$/task/progress', { taskId: 't1' }, { stats: true })
    ).toBe(false)
  })

  it('--task keeps only that task and drops $/stats', () => {
    expect(
      shouldEmit('$/task/progress', { taskId: 't1' }, { task: 't1' })
    ).toBe(true)
    expect(
      shouldEmit('$/task/progress', { taskId: 't2' }, { task: 't1' })
    ).toBe(false)
    expect(shouldEmit('$/stats', {}, { task: 't1' })).toBe(false)
  })

  it('no filter keeps everything', () => {
    expect(shouldEmit('$/stats', {}, {})).toBe(true)
    expect(shouldEmit('$/task/progress', { taskId: 't1' }, {})).toBe(true)
  })
})

describe('formatWatchEvent', () => {
  it('emits {event,data} NDJSON in json mode', () => {
    const line = formatWatchEvent('$/stats', { activeTasks: 2 }, true)
    expect(JSON.parse(line)).toEqual({
      event: '$/stats',
      data: { activeTasks: 2 },
    })
  })

  it('emits a compact human line for progress in non-json mode', () => {
    const line = formatWatchEvent(
      '$/task/progress',
      {
        taskId: 't1',
        phase: 'downloading',
        bytesDone: 1,
        bytesTotal: 2,
        speedBps: 3,
      },
      false
    )
    expect(line).toContain('t1')
    expect(line).toContain('downloading')
  })
})

describe('runWatch', () => {
  it('streams frames as NDJSON when piped, then stops on abort', async () => {
    const cap = capture(false)
    const controller = new AbortController()
    const fetchImpl = vi.fn(async () =>
      sseResponse([progressFrame('t1'), statsFrame])
    )
    // abort during the post-stream backoff so we run exactly one connection
    const sleep = vi.fn(async () => {
      controller.abort()
    })
    await runWatch(
      {},
      { endpoint, fetchImpl, stdout: cap.stdout },
      { signal: controller.signal, sleep }
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(cap.lines).toHaveLength(2)
    expect(JSON.parse(cap.lines[0])).toMatchObject({ event: '$/task/progress' })
    expect(JSON.parse(cap.lines[1])).toMatchObject({ event: '$/stats' })
  })

  it('sends the Bearer header to /mdxp/events', async () => {
    const cap = capture(false)
    const controller = new AbortController()
    const fetchImpl = vi.fn(async () => sseResponse([statsFrame]))
    await runWatch(
      {},
      { endpoint, fetchImpl, stdout: cap.stdout },
      { signal: controller.signal, sleep: async () => controller.abort() }
    )
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ]
    expect(url).toBe('http://127.0.0.1:16801/mdxp/events')
    expect(init.headers.authorization).toBe('Bearer tok')
  })

  it('applies --task filtering client-side', async () => {
    const cap = capture(false)
    const controller = new AbortController()
    const fetchImpl = vi.fn(async () =>
      sseResponse([progressFrame('t1'), progressFrame('t2')])
    )
    await runWatch(
      { task: 't1' },
      { endpoint, fetchImpl, stdout: cap.stdout },
      { signal: controller.signal, sleep: async () => controller.abort() }
    )
    expect(cap.lines).toHaveLength(1)
    expect(JSON.parse(cap.lines[0]).data.taskId).toBe('t1')
  })

  it('maps HTTP 401 to EXIT.AUTH', async () => {
    const cap = capture(false)
    const fetchImpl = vi.fn(async () => sseResponse([], 401))
    await expect(
      runWatch({}, { endpoint, fetchImpl, stdout: cap.stdout })
    ).rejects.toMatchObject({ exitCode: EXIT.AUTH })
  })

  it('maps a first-connect failure to EXIT.NETWORK', async () => {
    const cap = capture(false)
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(
      runWatch({}, { endpoint, fetchImpl, stdout: cap.stdout })
    ).rejects.toMatchObject({ exitCode: EXIT.NETWORK })
  })

  it('reconnects after a stream drop (until aborted)', async () => {
    const cap = capture(false)
    const controller = new AbortController()
    const fetchImpl = vi.fn(async () => sseResponse([statsFrame]))
    let n = 0
    const sleep = vi.fn(async () => {
      if (++n >= 2) controller.abort()
    })
    await runWatch(
      {},
      { endpoint, fetchImpl, stdout: cap.stdout },
      { signal: controller.signal, sleep }
    )
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
