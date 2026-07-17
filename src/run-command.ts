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
 * Quote a single argument for cmd.exe. `spawn(..., { shell: true })` on
 * win32 hands `cmd+args` to `cmd.exe /d /s /c`, which joins them with plain
 * spaces and applies no quoting of its own. Two consequences: an arg with an
 * embedded space (e.g. a path under `C:\Users\John Smith\...`) splits into
 * multiple argv entries, and `^` — cmd.exe's escape character — is consumed
 * before the target program ever sees it (so `^0.2.0` becomes `0.2.0`).
 * Wrapping in double quotes fixes both: cmd.exe keeps a quoted string as one
 * argument, and treats `^` literally while inside quotes. Embedded `"` are
 * doubled, cmd.exe's own escape for a literal quote inside a quoted string.
 */
export function escapeForCmdShell(arg: string): string {
  return `"${arg.replaceAll('"', '""')}"`
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
 * used there; `cmd` and every element of `args` are cmd.exe-quoted
 * (`escapeForCmdShell`) before being handed to `spawn` so that paths with
 * spaces (including `cmd` itself — e.g. the default Windows install path
 * `C:\Program Files\nodejs\node.exe`) and `^`-containing ranges survive
 * cmd.exe's own parsing. A shell also means spawn failures surface as a
 * non-zero exit instead of `code: null` on win32.
 *
 * `opts.timeoutMs` bounds the run: on expiry the process (tree, on win32) is
 * killed and the result carries `timedOut: true` — a stuck registry query or
 * install can never hang self-update forever. `opts.maxBuffer` caps each
 * captured stream (tail retained) so pathological output can't exhaust memory.
 */
export const runCommand: RunCommand = (cmd, args, opts) =>
  new Promise((resolve) => {
    const useShell = process.platform === 'win32'
    const child = spawn(
      useShell ? escapeForCmdShell(cmd) : cmd,
      useShell ? args.map(escapeForCmdShell) : args,
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
    try {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' })
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
