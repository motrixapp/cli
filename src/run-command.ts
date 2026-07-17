import { spawn } from 'node:child_process'

export interface RunResult {
  /** Exit code; null when the binary could not be spawned or was killed. */
  code: number | null
  stdout: string
  stderr: string
  spawnError?: NodeJS.ErrnoException
  /** The named binary does not exist (POSIX ENOENT, or win32 cmd.exe 9009). */
  commandMissing?: boolean
  /** The process was killed after exceeding `opts.timeoutMs`. */
  timedOut?: boolean
  /** Captured output hit `opts.maxBuffer`; only the tail is retained. */
  truncated?: boolean
}

export type RunCommand = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; maxBuffer?: number }
) => Promise<RunResult>

/** Per-stream capture cap (bytes). A pathological installer must not be able
 *  to OOM the process; we keep the tail, where errors surface. */
const DEFAULT_MAX_BUFFER = 1_000_000

/**
 * cmd.exe metacharacters. Anything here is interpreted by the command
 * processor before the target program's argv parser runs, so each must be
 * caret-escaped when the string passes through `cmd.exe /c`. Mirrors
 * cross-spawn's set (the reference implementation behind CVE-2024-27980,
 * "BatBadBut").
 */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/**
 * Escape a *command* (the executable token) for `cmd.exe /c`. cmd.exe reads
 * the command before the child's argv parser does, so only the shell-meta
 * layer applies — caret-escape metacharacters (including spaces, so a path
 * like `C:\Program Files\nodejs\node.exe` survives). No surrounding quotes:
 * that's the cross-spawn convention, and quoting the command would itself need
 * meta-escaping. Verbatim from cross-spawn's `escapeCommand`.
 */
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, '^$1')
}

/**
 * Escape an *argument* for `cmd.exe /c`, the two-layer Windows escaping
 * ported verbatim from cross-spawn (the algorithm from qntm.org/cmd):
 *
 * 1. CommandLineToArgvW layer — double every run of backslashes that precedes
 *    a `"` (and the trailing run, which becomes adjacent to the wrapping
 *    quote), escape the `"` itself, then wrap the whole arg in double quotes.
 *    A bare `\"` or a trailing `\` would otherwise be mis-parsed.
 * 2. cmd.exe layer — caret-escape every metacharacter (the wrapping quotes
 *    included; under `cmd /c` a `^"` collapses back to a literal `"` for the
 *    argv parser). When the ultimate target is a `.cmd`/`.bat` shim (npm,
 *    pnpm, yarn on Windows), cmd.exe re-parses the arguments a second time, so
 *    the meta layer is applied twice — this is the BatBadBut mitigation.
 *
 * This composes with Node's `spawn(..., { shell: true })`, which on win32
 * builds exactly `cmd.exe /d /s /c "<file> <args…>"` with
 * windowsVerbatimArguments — the same invocation cross-spawn constructs by
 * hand — so identically-escaped tokens yield an identical command line.
 */
export function escapeCmdArgument(
  argument: string,
  doubleEscapeMetaChars = false
): string {
  let arg = `${argument}`
  arg = arg.replace(/(\\*)"/g, '$1$1\\"')
  arg = arg.replace(/(\\*)$/, '$1$1')
  arg = `"${arg}"`
  arg = arg.replace(CMD_META, '^$1')
  if (doubleEscapeMetaChars) arg = arg.replace(CMD_META, '^$1')
  return arg
}

/**
 * Whether a command, run through cmd.exe, resolves to a `.cmd`/`.bat` shim
 * (which cmd re-parses, requiring double meta-escaping of arguments). The JS
 * package managers (`npm`, `pnpm`, `yarn`) ship as `.cmd` shims on Windows and
 * are passed as bare names; `node`/the resolved bin paths we spawn are `.exe`.
 * Over-including an `.exe` here is harmless for our argument set (none contains
 * a metacharacter once the version spec passes `SPEC_RE`), so a bare name with
 * no extension is conservatively treated as a shim.
 */
function looksLikeBatchShim(command: string): boolean {
  if (/\.(?:cmd|bat)$/i.test(command)) return true
  return !/[\\/]/.test(command) && !/\.[a-z0-9]+$/i.test(command)
}

/**
 * Whether a *completed* process indicates the command was not found. On POSIX
 * a missing binary never reaches here — it fails as a spawn `ENOENT` error
 * (handled separately). On win32 the command runs through cmd.exe, which exits
 * 9009 ("'x' is not recognized as an internal or external command") for a
 * missing command rather than emitting a spawn error. 9009 is the reliable,
 * locale-independent signal; the English phrase is a best-effort backup.
 * Deliberately narrow so a real tool error like npm's `E404 ... not found`
 * (exit 1) is NOT misclassified as a missing command.
 */
export function isCommandMissing(
  code: number | null,
  stderr: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'win32') return false
  return (
    code === 9009 ||
    /is not recognized as an internal or external command/i.test(stderr)
  )
}

/**
 * Buffered, non-interactive command runner. stdin is ignored and output is
 * captured, not streamed: npm can prompt mid-install, and a hidden prompt on
 * piped stdio reads as a hang — captured output is printed only on failure.
 * On win32 the package-manager entry points are `.cmd` shims, which Node
 * refuses to spawn without a shell (EINVAL, CVE-2024-27980), so a shell is
 * used there; the command and every argument are cmd.exe-escaped
 * (`escapeCmdCommand` / `escapeCmdArgument`, the cross-spawn two-layer
 * algorithm) before being handed to `spawn`, so paths with spaces (including
 * the default Windows node path `C:\Program Files\nodejs\node.exe`), `^`-based
 * ranges, and shell metacharacters all survive cmd.exe's parsing — including
 * the second parse that `.cmd`/`.bat` shims trigger (BatBadBut). A shell also
 * means spawn failures surface as a non-zero exit instead of `code: null`.
 *
 * `opts.timeoutMs` bounds the run: on expiry the process (tree, on win32) is
 * killed and the result carries `timedOut: true` — a stuck registry query or
 * install can never hang self-update forever. `opts.maxBuffer` caps each
 * captured stream (tail retained) so pathological output can't exhaust memory.
 */
export const runCommand: RunCommand = (cmd, args, opts) =>
  new Promise((resolve) => {
    const useShell = process.platform === 'win32'
    const doubleMeta = useShell && looksLikeBatchShim(cmd)
    const child = spawn(
      useShell ? escapeCmdCommand(cmd) : cmd,
      useShell ? args.map((a) => escapeCmdArgument(a, doubleMeta)) : args,
      {
        cwd: opts?.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: useShell,
      }
    )
    const cap = opts?.maxBuffer ?? DEFAULT_MAX_BUFFER
    let stdout = ''
    let stderr = ''
    let truncated = false
    const append = (chunk: string, which: 'out' | 'err') => {
      if (which === 'out') {
        stdout += chunk
        if (stdout.length > cap) {
          stdout = stdout.slice(-cap)
          truncated = true
        }
      } else {
        stderr += chunk
        if (stderr.length > cap) {
          stderr = stderr.slice(-cap)
          truncated = true
        }
      }
    }
    child.stdout?.on('data', (d: Buffer) => append(d.toString(), 'out'))
    child.stderr?.on('data', (d: Buffer) => append(d.toString(), 'err'))

    let timedOut = false
    let timer: NodeJS.Timeout | undefined
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        killTree(child.pid)
      }, opts.timeoutMs)
      timer.unref?.()
    }
    const done = (r: RunResult) => {
      if (timer) clearTimeout(timer)
      resolve({ ...r, truncated: truncated || undefined })
    }

    child.on('error', (spawnError: NodeJS.ErrnoException) => {
      done({
        code: null,
        stdout,
        stderr,
        spawnError,
        commandMissing: spawnError.code === 'ENOENT' || undefined,
      })
    })
    // 'close' (not 'exit') so the stdio streams are fully flushed first.
    child.on('close', (code) => {
      done({
        code,
        stdout,
        stderr,
        timedOut: timedOut || undefined,
        commandMissing: isCommandMissing(code, stderr) || undefined,
      })
    })
  })

/** Best-effort kill of a child and its descendants. On win32 the child is a
 *  cmd.exe wrapper whose grandchildren (npm/node) would survive a plain kill,
 *  so use `taskkill /t`; on POSIX SIGTERM then a delayed SIGKILL. */
function killTree(pid: number | undefined): void {
  if (pid == null) return
  if (process.platform === 'win32') {
    // Resolve taskkill by absolute path (from %SystemRoot%) rather than
    // trusting PATH — avoids a PATH-planted `taskkill` and works when PATH is
    // minimal. Matches execa's hardening.
    const taskkill = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\taskkill.exe`
    try {
      spawn(taskkill, ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' })
    } catch {
      // best effort
    }
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const grace = setTimeout(() => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }, 2000)
  grace.unref?.()
}
