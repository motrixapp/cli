import type { ResolvedEndpoint } from './discovery'
import { CliError, EXIT } from './errors'

export type FetchLike = typeof fetch

interface JsonRpcResponse<T> {
  jsonrpc?: string
  id?: unknown
  result?: T
  error?: { code: number; message: string; data?: unknown }
}

/**
 * Single unary JSON-RPC 2.0 request over `POST /mdxp` (NOT a duplex MDXP
 * connection — the agent/CLI use-case is request→response). Maps transport
 * outcomes to the CLI exit-code contract: a connection failure → NETWORK,
 * HTTP 401/403 → AUTH, any JSON-RPC error → SERVER.
 *
 * `fetchImpl` is injectable for tests; it defaults to the global `fetch`.
 */
export async function rpcCall<T = unknown>(
  endpoint: ResolvedEndpoint,
  method: string,
  params: unknown,
  fetchImpl: FetchLike = fetch
): Promise<T> {
  let res: Response
  try {
    res = await fetchImpl(`${endpoint.baseUrl}/mdxp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${endpoint.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  } catch {
    throw new CliError(
      EXIT.NETWORK,
      `cannot reach Motrix bridge at ${endpoint.baseUrl}`
    )
  }

  if (res.status === 401 || res.status === 403) {
    throw new CliError(
      EXIT.AUTH,
      'authentication failed — check your token or re-pair'
    )
  }

  // No `/mdxp` route: either the endpoint is wrong, or this Motrix predates the
  // CLI bridge. Say so plainly instead of failing later on a non-JSON body.
  if (res.status === 404) {
    throw new CliError(
      EXIT.SERVER,
      `no MDXP bridge at ${endpoint.baseUrl} (HTTP 404) — check --endpoint, or update Motrix if it is too old to expose the /mdxp bridge`
    )
  }

  let body: JsonRpcResponse<T>
  try {
    body = (await res.json()) as JsonRpcResponse<T>
  } catch {
    throw new CliError(
      EXIT.SERVER,
      `invalid response from bridge (HTTP ${res.status})`
    )
  }

  if (body.error) {
    // `-32601 Method not found` means the bridge doesn't know a method this CLI
    // sent — a protocol drift between the app and the CLI. Turn the terse
    // JSON-RPC text into an actionable upgrade hint, but keep the original
    // error as `data` so `--json` consumers can still branch on `code`.
    if (body.error.code === -32601) {
      throw new CliError(
        EXIT.SERVER,
        `Motrix does not recognize the '${method}' method — your Motrix app may be older than this CLI (or the CLI newer than the app). Update Motrix, or install a matching @motrix/cli`,
        body.error
      )
    }
    throw new CliError(EXIT.SERVER, body.error.message, body.error)
  }
  return body.result as T
}
