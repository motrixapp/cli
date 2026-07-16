import { spawn } from 'node:child_process'

export interface RunResult {
  /** Exit code; null when the binary could not be spawned (e.g. ENOENT). */
  code: number | null
  stdout: string
  stderr: string
  spawnError?: NodeJS.ErrnoException
}

export type RunCommand = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string }
) => Promise<RunResult>

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
 * Buffered, non-interactive command runner. stdin is ignored and output is
 * captured, not streamed: npm can prompt mid-install, and a hidden prompt on
 * piped stdio reads as a hang — captured output is printed only on failure.
 * On win32 the package-manager entry points are `.cmd` shims, which Node
 * refuses to spawn without a shell (EINVAL, CVE-2024-27980), so a shell is
 * used there; args are cmd.exe-quoted (`escapeForCmdShell`) before being
 * handed to `spawn` so that paths with spaces and `^`-containing ranges
 * survive cmd.exe's own parsing — `cmd` itself is left alone since our
 * commands are always bare names (`npm`, `node`, ...). A shell also means
 * spawn failures surface as a non-zero exit instead of `code: null` on
 * win32.
 */
export const runCommand: RunCommand = (cmd, args, opts) =>
  new Promise((resolve) => {
    const useShell = process.platform === 'win32'
    const child = spawn(cmd, useShell ? args.map(escapeForCmdShell) : args, {
      cwd: opts?.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (spawnError: NodeJS.ErrnoException) => {
      resolve({ code: null, stdout, stderr, spawnError })
    })
    // 'close' (not 'exit') so the stdio streams are fully flushed first.
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
