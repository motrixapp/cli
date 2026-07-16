export interface SseFrame {
  event: string
  /** Raw data payload (concatenated `data:` lines); the caller JSON-parses it. */
  data: string
}

function parseBlock(block: string): SseFrame | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue // blank or comment
    if (line.startsWith('event:')) {
      event = line.slice(6).replace(/^ /, '')
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    // id:/retry:/unknown fields are ignored
  }
  if (dataLines.length === 0) return null // comment-only / fieldless block
  return { event, data: dataLines.join('\n') }
}

/**
 * Parse complete SSE frames out of an accumulated buffer. Frames are separated
 * by a blank line; a trailing partial frame is returned in `rest` for the next
 * chunk. CRLF is normalized; comment (`:`) lines are skipped.
 */
export function parseSseFrames(raw: string): {
  frames: SseFrame[]
  rest: string
} {
  let buf = raw.replace(/\r\n/g, '\n')
  const frames: SseFrame[] = []
  let idx = buf.indexOf('\n\n')
  while (idx !== -1) {
    const block = buf.slice(0, idx)
    buf = buf.slice(idx + 2)
    const frame = parseBlock(block)
    if (frame) frames.push(frame)
    idx = buf.indexOf('\n\n')
  }
  return { frames, rest: buf }
}

/**
 * Read an SSE `ReadableStream` to completion, invoking `onFrame` per frame.
 * Uses `getReader()` (NOT `for await`) for Node 18 portability, and a streaming
 * `TextDecoder` to survive multi-byte/chunk-boundary splits.
 */
export async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      if (signal?.aborted) break
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (err) {
        // An abort (SIGINT) rejects the in-flight read — treat as a clean stop.
        if (signal?.aborted) break
        throw err
      }
      if (chunk.done) break
      buf += decoder.decode(chunk.value, { stream: true })
      const { frames, rest } = parseSseFrames(buf)
      buf = rest
      for (const frame of frames) onFrame(frame)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // reader may already be released on a closed stream
    }
  }
}
