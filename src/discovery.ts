import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tokenForEndpoint } from './credentials'
import { CliError, EXIT } from './errors'

/** Shape of `<userData>/bridge/endpoint.json` written by the desktop bridge. */
export interface EndpointFile {
  port: number
  pid: number
  localToken: string
  writtenAt?: number
}

export interface ResolvedEndpoint {
  /** Base URL without trailing slash; `/mdxp` is appended by the client. */
  baseUrl: string
  token: string
}

export interface ResolveOpts {
  /** `--endpoint <url>` — a full base URL (e.g. a remote NAS). */
  endpoint?: string
  /** `--token <t>`. */
  token?: string
  /** `MOTRIX_BRIDGE_TOKEN`. */
  envToken?: string
  /** A token stored by `motrix pair` for this endpoint (credentials.json). */
  credentialsToken?: string
}

/**
 * Per-platform Motrix userData directory — matches the desktop app + the
 * native-host: macOS `~/Library/Application Support/Motrix`, Windows
 * `%APPDATA%\Motrix`, Linux `$XDG_CONFIG_HOME|~/.config/Motrix`.
 */
export function userDataDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string
): string {
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Motrix')
  }
  if (platform === 'win32') {
    return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Motrix')
  }
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Motrix')
}

export function endpointFilePath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string
): string {
  return join(userDataDir(platform, env, home), 'bridge', 'endpoint.json')
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

/** The base-URL half of resolution (no token requirement) — also what the
 *  token-less `pair` command needs. Throws NETWORK when no bridge is found. */
export function resolveBaseUrl(
  file: EndpointFile | null,
  opts: { endpoint?: string },
  pidAlive: (pid: number) => boolean
): string {
  if (opts.endpoint) return stripTrailingSlash(opts.endpoint)
  if (!file) {
    throw new CliError(
      EXIT.NETWORK,
      'Motrix bridge not found — is Motrix running? (use --endpoint for a remote server)'
    )
  }
  if (!pidAlive(file.pid)) {
    throw new CliError(
      EXIT.NETWORK,
      'Motrix bridge endpoint is stale (the recorded process is not running)'
    )
  }
  return `http://127.0.0.1:${file.port}`
}

/**
 * Pure resolution of overrides + (optional) `endpoint.json` into a usable base
 * URL + token. `file` is null when no endpoint.json was found/parsed; `pidAlive`
 * tests the file pid's liveness. Throws a {@link CliError} (with the right exit
 * code) when there is not enough info to talk to a bridge.
 */
export function resolveEndpoint(
  file: EndpointFile | null,
  opts: ResolveOpts,
  pidAlive: (pid: number) => boolean
): ResolvedEndpoint {
  const baseUrl = resolveBaseUrl(file, opts, pidAlive)

  // A remote --endpoint must NOT borrow the local file token — that token only
  // authenticates the local bridge. A credential stored by `motrix pair` (for
  // this exact endpoint) is the remote path, taking effect when no explicit
  // --token / env token is given.
  const token =
    opts.token ??
    opts.envToken ??
    opts.credentialsToken ??
    (opts.endpoint ? undefined : file?.localToken)
  if (!token) {
    throw new CliError(
      EXIT.USAGE,
      'no bridge token — pass --token, set MOTRIX_BRIDGE_TOKEN, or run `motrix pair`'
    )
  }
  return { baseUrl, token }
}

/** Default liveness probe: signal 0 throws ESRCH if the pid is gone; EPERM
 *  means it exists but is owned by another user (still alive). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readEndpointFile(
  endpoint: string | undefined,
  env: NodeJS.ProcessEnv
): Promise<EndpointFile | null> {
  if (endpoint) return null
  try {
    const raw = await readFile(
      endpointFilePath(process.platform, env, homedir()),
      'utf-8'
    )
    return JSON.parse(raw) as EndpointFile
  } catch {
    return null
  }
}

/** Resolve just the bridge base URL (no token) — for the `pair` command, which
 *  runs before any token exists. */
export async function discoverBaseUrl(
  opts: { endpoint?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<string> {
  const env = opts.env ?? process.env
  const file = await readEndpointFile(opts.endpoint, env)
  return resolveBaseUrl(file, { endpoint: opts.endpoint }, isPidAlive)
}

/** Read endpoint.json (when no --endpoint) and resolve to a base URL + token.
 *  When no --token/env token is set, fall back to a `motrix pair` credential
 *  stored for the resolved endpoint. */
export async function discoverEndpoint(
  opts: { endpoint?: string; token?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<ResolvedEndpoint> {
  const env = opts.env ?? process.env
  const file = await readEndpointFile(opts.endpoint, env)
  const envToken = env.MOTRIX_BRIDGE_TOKEN

  let credentialsToken: string | undefined
  if (!opts.token && !envToken) {
    try {
      const baseUrl = resolveBaseUrl(
        file,
        { endpoint: opts.endpoint },
        isPidAlive
      )
      credentialsToken = (await tokenForEndpoint(baseUrl)) ?? undefined
    } catch {
      // No reachable bridge — let resolveEndpoint surface the precise error.
    }
  }

  return resolveEndpoint(
    file,
    { endpoint: opts.endpoint, token: opts.token, envToken, credentialsToken },
    isPidAlive
  )
}
