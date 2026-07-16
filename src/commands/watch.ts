import type { CommandIo } from '../command-io'
import { CliError, EXIT } from '../errors'
import { formatBytes, wantsJson } from '../output'
import { consumeSseStream } from '../sse'

export interface WatchOpts {
  task?: string
  stats?: boolean
}

export interface WatchDeps {
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
}

/** Client-side filter: --stats isolates $/stats; --task keeps only that task's
 *  events (and drops the task-less $/stats). */
export function shouldEmit(
  event: string,
  data: unknown,
  opts: WatchOpts
): boolean {
  if (opts.stats && event !== '$/stats') return false
  if (opts.task) {
    if (event === '$/stats') return false
    const taskId = (data as { taskId?: string }).taskId
    if (taskId !== opts.task) return false
  }
  return true
}

/** One output line per event: NDJSON {event,data} in machine mode, a compact
 *  line in human/TTY mode. */
export function formatWatchEvent(
  event: string,
  data: unknown,
  json: boolean
): string {
  if (json) return `${JSON.stringify({ event, data })}\n`
  const d = data as Record<string, unknown>
  switch (event) {
    case '$/task/progress': {
      const total =
        d.bytesTotal == null
          ? formatBytes(Number(d.bytesDone))
          : `${formatBytes(Number(d.bytesDone))}/${formatBytes(Number(d.bytesTotal))}`
      return `${d.taskId}  ${d.phase}  ${total}  ${formatBytes(Number(d.speedBps))}/s\n`
    }
    case '$/task/completed':
      return `${d.taskId}  ✓ completed → ${d.filePath}\n`
    case '$/task/error':
      return `${d.taskId}  ✗ error: ${d.message}\n`
    case '$/stats':
      return `↓${formatBytes(Number(d.totalDownloadSpeed))}/s ↑${formatBytes(Number(d.totalUploadSpeed))}/s  active=${d.activeTasks} waiting=${d.waitingTasks} stopped=${d.stoppedTasks}\n`
    default:
      return `${JSON.stringify({ event, data })}\n`
  }
}

const MAX_BACKOFF_MS = 10_000

/**
 * Stream `GET /mdxp/events` as NDJSON (or a compact human view). The first
 * connect failure is fatal (EXIT.NETWORK); 401/403 → EXIT.AUTH; once connected,
 * a stream drop triggers reconnect-with-backoff (a watch is meant to run until
 * interrupted). SIGINT aborts the injected signal → clean exit (0) at the bin.
 */
export async function runWatch(
  opts: WatchOpts,
  io: CommandIo,
  deps: WatchDeps = {}
): Promise<void> {
  const fetchImpl = io.fetchImpl ?? fetch
  const json = wantsJson({ json: io.json }, io.stdout)
  const signal = deps.signal
  // Default sleep is abort-aware: a SIGINT during the reconnect backoff resolves
  // it immediately (otherwise the loop would wait up to MAX_BACKOFF_MS before
  // its next abort check and the CLI would appear to hang on Ctrl-C).
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve()
          return
        }
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true }
        )
      }))
  const url = `${io.endpoint.baseUrl}/mdxp/events`
  let first = true
  let backoff = 500

  while (!signal?.aborted) {
    let res: Response
    try {
      res = await fetchImpl(url, {
        headers: {
          authorization: `Bearer ${io.endpoint.token}`,
          accept: 'text/event-stream',
        },
        signal,
      })
    } catch {
      if (signal?.aborted) break
      if (first) {
        throw new CliError(
          EXIT.NETWORK,
          `cannot reach Motrix bridge at ${io.endpoint.baseUrl}`
        )
      }
      await sleep(backoff)
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      continue
    }

    if (res.status === 401 || res.status === 403) {
      throw new CliError(
        EXIT.AUTH,
        'authentication failed — check your token or re-pair'
      )
    }
    if (!res.ok || !res.body) {
      if (first) {
        throw new CliError(
          EXIT.NETWORK,
          `unexpected response from Motrix bridge (HTTP ${res.status})`
        )
      }
      await sleep(backoff)
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      continue
    }

    first = false
    backoff = 500
    await consumeSseStream(
      res.body,
      (frame) => {
        let data: unknown
        try {
          data = JSON.parse(frame.data)
        } catch {
          return // skip wire drift; never kill a long-running watch
        }
        if (!shouldEmit(frame.event, data, opts)) return
        io.stdout.write(formatWatchEvent(frame.event, data, json))
      },
      signal
    )

    // Stream ended (server closed or network drop). Reconnect unless aborted.
    if (signal?.aborted) break
    await sleep(backoff)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }
}
