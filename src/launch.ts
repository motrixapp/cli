import { spawn } from 'node:child_process'

/** A platform command that hands a URL to its registered scheme handler. */
export interface Opener {
  cmd: string
  args: string[]
}

/** The URL-opener for a platform. The scheme handler (the installed Motrix
 *  app, which registers `motrix://`) does the actual launch/focus. */
export function openerFor(platform: NodeJS.Platform): Opener {
  if (platform === 'darwin') return { cmd: 'open', args: [] }
  // `start` needs a first quoted arg (window title); '' keeps the URL as target.
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', ''] }
  return { cmd: 'xdg-open', args: [] }
}

export interface SpawnResult {
  /** Opener exit code; `null` when the opener binary could not be spawned. */
  code: number | null
  spawnError?: NodeJS.ErrnoException
}

export type SpawnOpener = (opener: Opener, url: string) => Promise<SpawnResult>

/** Default opener: run `<cmd> <args...> <url>` and resolve its exit code.
 *  A non-zero code means the scheme has no handler (app not installed);
 *  `code: null` + `spawnError` means the opener binary itself is missing. */
export const spawnOpener: SpawnOpener = (opener, url) =>
  new Promise((resolve) => {
    const child = spawn(opener.cmd, [...opener.args, url], { stdio: 'ignore' })
    child.on('error', (spawnError: NodeJS.ErrnoException) => {
      resolve({ code: null, spawnError })
    })
    child.on('exit', (code) => resolve({ code }))
  })
