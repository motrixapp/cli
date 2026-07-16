import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { userDataDir } from './discovery'

/**
 * Per-endpoint CLI device handle store. The handle is a stable, high-entropy
 * id this CLI install presents on every `motrix pair` for a given bridge, so
 * the SAME agent re-pairing rotates its prior token (and the bridge closes its
 * old SSE) instead of accumulating a fresh principal each time.
 *
 * It is deliberately NOT stored in `credentials.json`: the handle is not a
 * secret (it only names an identity the operator still has to approve), and the
 * credentials file is a guarded secrets store. Keeping the handle in its own
 * 0600 file keeps the secrets file secrets-only.
 *
 * NOTE (concurrency): a read-modify-write store can lose an update if two
 * `motrix pair` processes pair the SAME endpoint for the FIRST time at the exact
 * same moment — each reads an empty store and submits a different handle, so the
 * bridge sees two principals instead of one rotation. This is an accepted
 * low-risk edge: it requires two simultaneous, separately operator-approved
 * pairings on one endpoint, the outcome is two approved (revocable) tokens, and
 * it does NOT breach the revoke→close-SSE security boundary. The far more likely
 * failure — a corrupt/legacy stored value silently disabling rotation forever —
 * IS handled below by validating every value against the bridge's handle rule.
 */

/**
 * Accepted device-handle shape — MIRROR of `DEVICE_HANDLE_RE` in
 * `src/core/bridge/DeviceCodeService.ts`. The CLI cannot import `@core` across
 * the package boundary, so the rule is duplicated; keep both in sync. base64url,
 * 16–64 chars: enough entropy, and the length floor structurally excludes short
 * reserved ids (e.g. `local`). A stored value that fails this is treated as
 * absent, so a corrupt/legacy/hand-edited store cannot permanently disable
 * rotation (the bridge would reject the bad handle and fork a new principal on
 * every re-pair).
 */
const DEVICE_HANDLE_RE = /^[A-Za-z0-9_-]{16,64}$/

function isValidHandle(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_HANDLE_RE.test(value)
}

/** `<userData>/bridge/cli-device-ids.json` — sibling of `endpoint.json`. */
function defaultDeviceIdPath(): string {
  return join(
    userDataDir(process.platform, process.env, homedir()),
    'bridge',
    'cli-device-ids.json'
  )
}

/** baseUrl → device handle (values are validated on read, not trusted blindly). */
type DeviceIdFile = Record<string, unknown>

async function load(path: string): Promise<DeviceIdFile> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as DeviceIdFile) : {}
  } catch {
    // Missing/corrupt file → start fresh; a bad store must not break pairing.
    return {}
  }
}

/** Atomic write: a temp file + rename, so a reader never sees a half-written
 *  store and a crash mid-write cannot corrupt the existing one. */
async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tmp, data, { mode: 0o600 })
  await rename(tmp, path)
}

/** The persisted device handle for an endpoint, or null if none/invalid. */
export async function deviceIdForEndpoint(
  baseUrl: string,
  path: string = defaultDeviceIdPath()
): Promise<string | null> {
  const stored = (await load(path))[baseUrl]
  return isValidHandle(stored) ? stored : null
}

/**
 * Return the endpoint's device handle, minting + persisting a fresh 128-bit one
 * (mode 0600) on first use OR when the stored value is malformed. Idempotent for
 * a valid stored handle: a second call returns the same one, which is what makes
 * a re-pair rotate rather than fork a new identity. Other endpoints' handles are
 * preserved across the rewrite.
 */
export async function ensureDeviceId(
  baseUrl: string,
  path: string = defaultDeviceIdPath()
): Promise<string> {
  const file = await load(path)
  const existing = file[baseUrl]
  if (isValidHandle(existing)) return existing
  const id = randomBytes(16).toString('base64url')
  file[baseUrl] = id
  await writeFileAtomic(path, JSON.stringify(file, null, 2))
  return id
}
