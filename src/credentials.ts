import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * CLI-owned credential store: device-code tokens keyed by bridge endpoint, so
 * `motrix pair` against a remote NAS persists a token the later commands reuse
 * without re-passing `--token`. This is DISTINCT from the desktop's userData
 * `endpoint.json` (machine-owner local token) — a remote token has no home
 * there. The file is mode 0600 (a bearer token is a secret) and never logged.
 */
export interface StoredCredential {
  token: string
  clientName?: string
  pairedAt?: number
}

export type CredentialsFile = Record<string, StoredCredential>

/** `~/.config/motrix/credentials.json` (honors `XDG_CONFIG_HOME`). Lowercase
 *  `motrix` — a CLI config dir, not the desktop app's `Motrix` userData. */
export function credentialsFilePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  const base = env.XDG_CONFIG_HOME ?? join(home, '.config')
  return join(base, 'motrix', 'credentials.json')
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

export async function loadCredentials(
  path: string = credentialsFilePath()
): Promise<CredentialsFile> {
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object'
      ? (parsed as CredentialsFile)
      : {}
  } catch {
    return {}
  }
}

/** The stored token for a given bridge endpoint, or null. */
export async function tokenForEndpoint(
  baseUrl: string,
  path: string = credentialsFilePath()
): Promise<string | null> {
  const creds = await loadCredentials(path)
  return creds[normalizeBaseUrl(baseUrl)]?.token ?? null
}

/** Persist (merge) a credential for an endpoint at mode 0600. chmod after write
 *  enforces 0600 even when overwriting a pre-existing, looser file. */
export async function saveToken(
  baseUrl: string,
  cred: StoredCredential,
  path: string = credentialsFilePath()
): Promise<void> {
  const creds = await loadCredentials(path)
  creds[normalizeBaseUrl(baseUrl)] = cred
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}
