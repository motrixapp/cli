import { hostname } from 'node:os'
import type { FetchLike } from '../client'
import { saveToken } from '../credentials'
import { ensureDeviceId } from '../device-id'
import { CliError, EXIT } from '../errors'
import { wantsJson } from '../output'

export interface PairOpts {
  /** `--name` — human label shown in the Motrix approval prompt. */
  name?: string
}

interface Stream {
  write(s: string): unknown
  isTTY?: boolean
}

/** Everything `runPair` needs; the side-effecting bits are injectable for
 *  tests (no real network, clock, or disk). */
export interface PairContext {
  /** Bridge base URL (no trailing slash); device-code routes hang off it. */
  baseUrl: string
  /** Machine channel: in --json / non-TTY mode receives a single JSON value. */
  stdout: Stream
  /** Human channel: the verification code + progress + a human success line.
   *  Kept off stdout so the machine contract stays parseable. */
  stderr: Stream
  json?: boolean
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Override credentials.json path (tests). */
  credentialsPath?: string
  /** Override the device-id store path (tests). */
  deviceIdPath?: string
  clientVersion?: string
  hostName?: string
}

interface RequestResponse {
  requestId: string
  userCode: string
  /** Optional: present only when the server knows its approval-UI URL. */
  verificationUri?: string
  expiresAt: number
  interval?: number
}

interface PollResponse {
  status: 'pending' | 'approved' | 'denied' | 'expired'
  token?: string
}

/**
 * Device-code pairing: request a code, print it for the user to approve in the
 * Motrix UI, poll until the decision lands, then persist the issued token to
 * `credentials.json` (mode 0600). Unlike the other commands this runs WITHOUT a
 * token (it is how a token is obtained) and talks to the REST `/mdxp/pair/*`
 * routes rather than the JSON-RPC `/mdxp` surface.
 */
export async function runPair(opts: PairOpts, ctx: PairContext): Promise<void> {
  const fetchImpl = ctx.fetchImpl ?? fetch
  const sleep =
    ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const now = ctx.now ?? Date.now
  const clientName = opts.name ?? `Motrix CLI (${ctx.hostName ?? hostname()})`
  const clientVersion = ctx.clientVersion ?? 'unknown'
  // Stable per-endpoint device handle: submitting the same one on every pair
  // lets the bridge rotate this CLI's prior token (and drop its old SSE) instead
  // of forking a fresh principal each time.
  const deviceId = await ensureDeviceId(ctx.baseUrl, ctx.deviceIdPath)

  // 1. request a device code
  let reqRes: Response
  try {
    reqRes = await fetchImpl(`${ctx.baseUrl}/mdxp/pair/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientName, clientVersion, deviceId }),
    })
  } catch {
    throw new CliError(
      EXIT.NETWORK,
      `cannot reach Motrix bridge at ${ctx.baseUrl}`
    )
  }
  if (reqRes.status === 429) {
    throw new CliError(
      EXIT.SERVER,
      'too many pairing requests — try again shortly'
    )
  }
  if (!reqRes.ok) {
    throw new CliError(
      EXIT.SERVER,
      `pairing request failed (HTTP ${reqRes.status})`
    )
  }
  const req = (await reqRes.json()) as RequestResponse

  // 2. prompt the human on STDERR — the verification code must be visible to
  //    approve, but it must never pollute stdout, which is the machine contract
  //    (--json / non-TTY → a single JSON value). Only print a URL when the
  //    server supplied a real one (the approval UI is a separate service the
  //    bridge can't reliably name).
  ctx.stderr.write(
    `\nApprove this pairing in Motrix:\n` +
      `  Verification code: ${req.userCode}\n` +
      (req.verificationUri ? `  ${req.verificationUri}\n` : '') +
      `\nWaiting for approval…\n`
  )

  // 3. poll until a terminal state or the request expires. POST (not GET) so the
  //    requestId rides the body, never the URL (keeps it out of access logs).
  const intervalMs = Math.max(1, req.interval ?? 2) * 1000
  while (now() < req.expiresAt) {
    await sleep(intervalMs)
    let pollRes: Response
    try {
      pollRes = await fetchImpl(`${ctx.baseUrl}/mdxp/pair/poll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: req.requestId }),
      })
    } catch {
      throw new CliError(
        EXIT.NETWORK,
        `cannot reach Motrix bridge at ${ctx.baseUrl}`
      )
    }
    const poll = (await pollRes.json()) as PollResponse
    if (poll.status === 'approved' && poll.token) {
      await saveToken(
        ctx.baseUrl,
        { token: poll.token, clientName, pairedAt: now() },
        ctx.credentialsPath
      )
      // Result on stdout: machine mode → a single JSON value; TTY → human.
      if (wantsJson({ json: ctx.json }, ctx.stdout)) {
        ctx.stdout.write(
          `${JSON.stringify({ paired: true, endpoint: ctx.baseUrl })}\n`
        )
      } else {
        ctx.stdout.write(`Paired. Token stored for ${ctx.baseUrl}.\n`)
      }
      return
    }
    if (poll.status === 'denied') {
      throw new CliError(EXIT.AUTH, 'pairing was denied in Motrix')
    }
    if (poll.status === 'expired') {
      throw new CliError(EXIT.SERVER, 'pairing request expired before approval')
    }
  }
  throw new CliError(EXIT.SERVER, 'pairing timed out before approval')
}
