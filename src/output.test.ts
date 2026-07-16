import type { MdxpTask, StatsResult } from '@motrix/mdxp'
import { describe, expect, it } from 'vitest'
import { formatBytes, formatStats, formatTaskList, wantsJson } from './output'

describe('wantsJson', () => {
  it('is true when --json is set, regardless of TTY', () => {
    expect(wantsJson({ json: true }, { isTTY: true })).toBe(true)
  })

  it('is true when the stream is not a TTY (piped/agent)', () => {
    expect(wantsJson({}, { isTTY: false })).toBe(true)
  })

  it('is false only for an interactive TTY without --json', () => {
    expect(wantsJson({}, { isTTY: true })).toBe(false)
  })
})

describe('formatBytes', () => {
  it('renders a human size', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toContain('KB')
  })

  it('renders unknown (null) total as a placeholder', () => {
    expect(formatBytes(null)).toBe('?')
  })
})

const task: MdxpTask = {
  id: 'task-1',
  type: 'http',
  name: 'ubuntu.iso',
  status: 'downloading',
  progress: 0.5,
  bytesDone: 500,
  bytesTotal: 1000,
  speedBps: 100,
  etaSec: 5,
  saveDir: '/dl',
  error: null,
  createdAt: 0,
  finishedAt: null,
  finalPath: null,
}

describe('formatTaskList', () => {
  it('includes the id, name, status and a percentage', () => {
    const out = formatTaskList({ tasks: [task], total: 1 })
    expect(out).toContain('task-1')
    expect(out).toContain('ubuntu.iso')
    expect(out).toContain('downloading')
    expect(out).toContain('50')
  })

  it('renders an empty-state line when there are no tasks', () => {
    const out = formatTaskList({ tasks: [], total: 0 })
    expect(out.toLowerCase()).toContain('no tasks')
  })
})

describe('formatStats', () => {
  it('summarizes speeds and task counts', () => {
    const stats: StatsResult = {
      totalDownloadSpeed: 2048,
      totalUploadSpeed: 0,
      activeTasks: 2,
      waitingTasks: 1,
      stoppedTasks: 3,
    }
    const out = formatStats(stats)
    expect(out).toContain('2') // active count
    expect(out.toLowerCase()).toContain('active')
  })
})
