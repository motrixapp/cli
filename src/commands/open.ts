import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { type EndpointFile, endpointFilePath, isPidAlive } from '../discovery'
import { EXIT, type ExitCode } from '../errors'
import { openerFor, type SpawnOpener, spawnOpener } from '../launch'

const POLL_MS = 250
const DEFAULT_TIMEOUT_MS = 15000

export interface OpenOpts {
  timeout?: number
  endpoint?: string
}

export interface OpenDeps {
  platform: NodeJS.Platform
  spawnOpener: SpawnOpener
  /** Base URL when the local bridge is up, else null. */
  probeBridge: () => Promise<string | null>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export type OpenReason =
  | 'remote_endpoint'
  | 'not_installed'
  | 'launch_timeout'
  | 'opener_missing'

export interface OpenResult {
  ok: boolean
  reason?: OpenReason
  exitCode: ExitCode
  alreadyRunning: boolean
  launched: boolean
  endpoint?: string
  waitedMs: number
  message: string
}

export async function runOpen(
  opts: OpenOpts,
  deps: OpenDeps
): Promise<OpenResult> {
  const { platform, spawnOpener: fire, probeBridge, sleep, now } = deps
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS

  if (opts.endpoint) {
    return {
      ok: false,
      reason: 'remote_endpoint',
      exitCode: EXIT.USAGE,
      alreadyRunning: false,
      launched: false,
      waitedMs: 0,
      message:
        'open only launches the local desktop app; a remote --endpoint cannot be launched',
    }
  }

  const before = await probeBridge()
  // Fire the opener in every case: cold-start when down, focus when up.
  const fired = await fire(openerFor(platform), 'motrix://')

  if (before !== null) {
    return {
      ok: true,
      exitCode: EXIT.OK,
      alreadyRunning: true,
      launched: false,
      endpoint: before,
      waitedMs: 0,
      message: `Motrix already running (${before})`,
    }
  }

  if (fired.spawnError) {
    return {
      ok: false,
      reason: 'opener_missing',
      exitCode: EXIT.NETWORK,
      alreadyRunning: false,
      launched: false,
      waitedMs: 0,
      message: 'could not open a URL on this system — start Motrix manually',
    }
  }

  if (fired.code !== 0) {
    return {
      ok: false,
      reason: 'not_installed',
      exitCode: EXIT.NOT_INSTALLED,
      alreadyRunning: false,
      launched: false,
      waitedMs: 0,
      message:
        'Motrix desktop app not found — install it from https://motrix.app, or use --endpoint for a remote server',
    }
  }

  const start = now()
  for (;;) {
    const endpoint = await probeBridge()
    if (endpoint !== null) {
      return {
        ok: true,
        exitCode: EXIT.OK,
        alreadyRunning: false,
        launched: true,
        endpoint,
        waitedMs: now() - start,
        message: `Motrix is ready (${endpoint})`,
      }
    }
    if (now() - start >= timeout) {
      return {
        ok: false,
        reason: 'launch_timeout',
        exitCode: EXIT.NETWORK,
        alreadyRunning: false,
        launched: false,
        waitedMs: now() - start,
        message: `Motrix was launched but its bridge did not come up within ${Math.round(
          timeout / 1000
        )}s. Try --timeout <ms>; if Motrix isn't installed, get it at https://motrix.app`,
      }
    }
    await sleep(POLL_MS)
  }
}

/** TCP reachability check — the bridge listens on 127.0.0.1:<port>. */
function tcpConnectable(
  host: string,
  port: number,
  timeoutMs = 1000
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** A usable TCP port from endpoint.json — guards net.connect, which throws
 *  synchronously on a port outside 1..65535 (a corrupt/partial file). */
export function isValidPort(port: unknown): port is number {
  return (
    typeof port === 'number' &&
    Number.isInteger(port) &&
    port > 0 &&
    port <= 65535
  )
}

/** Default probe: endpoint.json present + pid alive + port accepting TCP. */
export async function defaultProbeBridge(): Promise<string | null> {
  let file: EndpointFile
  try {
    const raw = await readFile(
      endpointFilePath(process.platform, process.env, homedir()),
      'utf-8'
    )
    file = JSON.parse(raw) as EndpointFile
  } catch {
    return null
  }
  if (!isValidPort(file.port) || !file.pid || !isPidAlive(file.pid)) return null
  const up = await tcpConnectable('127.0.0.1', file.port)
  return up ? `http://127.0.0.1:${file.port}` : null
}

export function defaultOpenDeps(): OpenDeps {
  return {
    platform: process.platform,
    spawnOpener,
    probeBridge: defaultProbeBridge,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  }
}
