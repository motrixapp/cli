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
 * Buffered, non-interactive command runner. stdin is ignored and output is
 * captured, not streamed: npm can prompt mid-install, and a hidden prompt on
 * piped stdio reads as a hang — captured output is printed only on failure.
 * On win32 the package-manager entry points are `.cmd` shims, which Node
 * refuses to spawn without a shell (EINVAL, CVE-2024-27980), so a shell is
 * used there; callers must pass only validated arguments (see SPEC_RE in
 * commands/self-update.ts). A shell also means spawn failures surface as a
 * non-zero exit instead of `code: null` on win32.
 */
export const runCommand: RunCommand = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
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
