import { describe, expect, it } from 'vitest'
import { consumeSseStream, parseSseFrames } from './sse'

describe('parseSseFrames', () => {
  it('parses a single event+data frame', () => {
    const { frames, rest } = parseSseFrames(
      'event: $/stats\ndata: {"activeTasks":2}\n\n'
    )
    expect(frames).toEqual([{ event: '$/stats', data: '{"activeTasks":2}' }])
    expect(rest).toBe('')
  })

  it('defaults event to "message" when only data is present', () => {
    const { frames } = parseSseFrames('data: hello\n\n')
    expect(frames).toEqual([{ event: 'message', data: 'hello' }])
  })

  it('skips comment (heartbeat) lines and yields no frame for a comment-only block', () => {
    const { frames } = parseSseFrames(': ping\n\n')
    expect(frames).toEqual([])
  })

  it('concatenates multiple data: lines with newline', () => {
    const { frames } = parseSseFrames('data: a\ndata: b\n\n')
    expect(frames[0].data).toBe('a\nb')
  })

  it('keeps a partial trailing frame in rest', () => {
    const { frames, rest } = parseSseFrames(
      'event: x\ndata: 1\n\nevent: y\ndata: 2'
    )
    expect(frames).toEqual([{ event: 'x', data: '1' }])
    expect(rest).toBe('event: y\ndata: 2')
  })

  it('handles CRLF line endings', () => {
    const { frames } = parseSseFrames('event: x\r\ndata: 1\r\n\r\n')
    expect(frames).toEqual([{ event: 'x', data: '1' }])
  })

  it('strips exactly one optional space after the colon', () => {
    const { frames } = parseSseFrames('data:nospace\n\n')
    expect(frames[0].data).toBe('nospace')
  })
})

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]))
      else controller.close()
    },
  })
}

describe('consumeSseStream', () => {
  it('emits each frame, buffering across chunk boundaries', async () => {
    // a frame split across two chunks
    const stream = streamOf([
      'event: $/task/progress\nda',
      'ta: {"taskId":"t1"}\n\n',
    ])
    const got: Array<{ event: string; data: string }> = []
    await consumeSseStream(stream, (f) => got.push(f))
    expect(got).toEqual([{ event: '$/task/progress', data: '{"taskId":"t1"}' }])
  })

  it('stops when the abort signal is already set', async () => {
    const controller = new AbortController()
    controller.abort()
    const stream = streamOf(['data: 1\n\n'])
    const got: unknown[] = []
    await consumeSseStream(stream, (f) => got.push(f), controller.signal)
    expect(got).toEqual([])
  })

  it('treats a read rejection as a clean stop when aborted (SIGINT)', async () => {
    const controller = new AbortController()
    // A stream whose read() rejects (as an aborted fetch body would)
    const stream = {
      getReader() {
        return {
          read: () => {
            controller.abort()
            return Promise.reject(new Error('aborted'))
          },
          releaseLock() {},
        }
      },
    } as unknown as ReadableStream<Uint8Array>
    await expect(
      consumeSseStream(stream, () => {}, controller.signal)
    ).resolves.toBeUndefined()
  })
})
