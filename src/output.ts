import type { MdxpTask, StatsResult, TaskListResult } from '@motrix/mdxp'

/**
 * Output mode: machine JSON when `--json` is set OR the stream is not a TTY
 * (piped into a file/agent). Interactive humans get the table. Defaulting
 * non-TTY to JSON is what makes the CLI agent-friendly without a flag.
 */
export function wantsJson(
  opts: { json?: boolean },
  stream: { isTTY?: boolean }
): boolean {
  return Boolean(opts.json) || !stream.isTTY
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/** Human byte size; `null` (unknown total) renders as `?`. */
export function formatBytes(n: number | null): string {
  if (n === null) return '?'
  if (n < 1) return '0 B'
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1)
  const value = n / 1024 ** i
  return i === 0 ? `${n} B` : `${value.toFixed(1)} ${UNITS[i]}`
}

function pct(progress: number): string {
  return `${Math.round(progress * 100)}%`
}

function formatEta(sec: number | null): string {
  if (sec === null) return '—'
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  return `${Math.round(sec / 3600)}h`
}

function formatTaskRow(t: MdxpTask): string {
  const size =
    t.bytesTotal === null
      ? formatBytes(t.bytesDone)
      : `${formatBytes(t.bytesDone)}/${formatBytes(t.bytesTotal)}`
  return [
    t.id.padEnd(12),
    pct(t.progress).padStart(4),
    t.status.padEnd(16),
    `${formatBytes(t.speedBps)}/s`.padStart(12),
    formatEta(t.etaSec).padStart(5),
    `  ${t.name}`,
    t.error ? `  (error: ${t.error})` : '',
    `  [${size}]`,
  ].join(' ')
}

export function formatTaskList(result: TaskListResult): string {
  if (result.tasks.length === 0) return 'No tasks.'
  const rows = result.tasks.map(formatTaskRow)
  const shown = result.tasks.length
  const footer =
    shown < result.total
      ? `\n(${shown} of ${result.total} tasks)`
      : `\n(${result.total} task${result.total === 1 ? '' : 's'})`
  return rows.join('\n') + footer
}

export function formatStats(stats: StatsResult): string {
  return [
    `Download: ${formatBytes(stats.totalDownloadSpeed)}/s   Upload: ${formatBytes(stats.totalUploadSpeed)}/s`,
    `Active: ${stats.activeTasks}   Waiting: ${stats.waitingTasks}   Stopped: ${stats.stoppedTasks}`,
  ].join('\n')
}

/** One-line summary of a single task — used by `add` (the created snapshot). */
export function formatTask(task: MdxpTask): string {
  return `${task.id}  ${task.name}  [${task.status}]  → ${task.saveDir}`
}
