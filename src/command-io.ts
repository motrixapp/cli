import type { FetchLike } from './client'
import type { ResolvedEndpoint } from './discovery'
import { wantsJson } from './output'

/** Everything a command needs to talk to the bridge and emit output. All
 *  side-effecting bits (fetch, stdout) are injectable so commands unit-test
 *  without a real network or terminal. */
export interface CommandIo {
  endpoint: ResolvedEndpoint
  fetchImpl?: FetchLike
  stdout: { write(s: string): unknown; isTTY?: boolean }
  /** `--json` flag. */
  json?: boolean
}

/** Emit a result: a single JSON value in machine mode, else a human string. */
export function emit(io: CommandIo, value: unknown, human: string): void {
  const json = wantsJson({ json: io.json }, io.stdout)
  io.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${human}\n`)
}
