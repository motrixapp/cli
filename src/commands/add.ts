import { readFile as fsReadFile } from 'node:fs/promises'
import { type DownloadAddParams, type MdxpTask, Methods } from '@motrix/mdxp'
import { rpcCall } from '../client'
import { type CommandIo, emit } from '../command-io'
import { CliError, EXIT } from '../errors'
import { formatTask } from '../output'

// Mirror of @motrix/mdxp's safeDownloadUrl scheme allow-list — a fast
// client-side gate; the server schema is authoritative.
const SAFE_DOWNLOAD_URL = /^(https?|ftps?|sftp):\/\//i

export interface AddOpts {
  saveDir?: string
  filename?: string
  /** repeatable `--header "Name: Value"` */
  header?: string[]
  connections?: number
  proxy?: string
  magnet?: string
  torrent?: string
  /** comma-separated indices, e.g. "0,2,5" */
  select?: string
}

function parseSelect(select: string | undefined): number[] | undefined {
  if (!select) return undefined
  const out = select
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
  if (out.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new CliError(
      EXIT.USAGE,
      `invalid --select (expected comma-separated non-negative integers): ${select}`
    )
  }
  return out
}

function parseHeaders(header: string[] | undefined): {
  name: string
  value: string
}[] {
  return (header ?? []).map((h) => {
    const idx = h.indexOf(':')
    if (idx <= 0) {
      throw new CliError(
        EXIT.USAGE,
        `invalid --header (expected "Name: Value"): ${h}`
      )
    }
    return { name: h.slice(0, idx).trim(), value: h.slice(idx + 1).trim() }
  })
}

export async function runAdd(
  urls: string[],
  opts: AddOpts,
  io: CommandIo,
  readFile: (path: string) => Promise<Buffer> = fsReadFile
): Promise<void> {
  if (!opts.saveDir) {
    throw new CliError(
      EXIT.USAGE,
      '--save-dir is required (the bridge API has no default save directory)'
    )
  }
  const saveDir = opts.saveDir
  const selectedFiles = parseSelect(opts.select)

  let params: DownloadAddParams
  if (opts.magnet) {
    params = {
      kind: 'magnet',
      saveDir,
      uri: opts.magnet,
      ...(selectedFiles ? { selectedFiles } : {}),
    }
  } else if (opts.torrent) {
    let base64: string
    try {
      base64 = (await readFile(opts.torrent)).toString('base64')
    } catch (e) {
      throw new CliError(
        EXIT.USAGE,
        `cannot read torrent file: ${opts.torrent} (${(e as Error).message})`
      )
    }
    params = {
      kind: 'torrent',
      saveDir,
      base64,
      ...(selectedFiles ? { selectedFiles } : {}),
    }
  } else {
    if (urls.length === 0) {
      throw new CliError(
        EXIT.USAGE,
        'provide one or more URLs, or --magnet <uri> / --torrent <file>'
      )
    }
    for (const u of urls) {
      if (!SAFE_DOWNLOAD_URL.test(u)) {
        throw new CliError(
          EXIT.USAGE,
          `unsupported URL scheme (allowed: http, https, ftp, ftps, sftp): ${u}`
        )
      }
    }
    const headers = parseHeaders(opts.header)
    params = {
      kind: 'url',
      saveDir,
      uris: urls,
      ...(opts.filename ? { filename: opts.filename } : {}),
      ...(headers.length > 0 ? { headers } : {}),
      ...(opts.connections !== undefined
        ? { connections: opts.connections }
        : {}),
      ...(opts.proxy ? { proxy: opts.proxy } : {}),
    }
  }

  const task = await rpcCall<MdxpTask>(
    io.endpoint,
    Methods.DownloadAdd,
    params,
    io.fetchImpl
  )
  emit(io, task, formatTask(task))
}
