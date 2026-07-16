/**
 * CLI exit-code contract — the stable surface an AI agent (or a shell script)
 * branches on. Mirrors the spec: 0 ok · 2 usage · 3 network (bridge down) ·
 * 4 auth (401/403) · 5 server error.
 */
export const EXIT = {
  OK: 0,
  USAGE: 2,
  NETWORK: 3,
  AUTH: 4,
  SERVER: 5,
  NOT_INSTALLED: 6,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** An error carrying the process exit code the CLI should terminate with. */
export class CliError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'CliError'
  }
}
