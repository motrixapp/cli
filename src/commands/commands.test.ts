import { describe, expect, it, vi } from 'vitest'
import type { CommandIo } from '../command-io'
import { runList } from './list'
import { runStats } from './stats'

function fakeFetch(body: unknown) {
  return vi
    .fn()
    .mockResolvedValue({ status: 200, json: async () => body } as Response)
}

function capture(isTTY: boolean) {
  let out = ''
  return {
    stdout: {
      write: (s: string) => {
        out += s
        return true
      },
      isTTY,
    },
    get text() {
      return out
    },
  }
}

const endpoint = { baseUrl: 'http://127.0.0.1:16801', token: 'tok' }

const taskListBody = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    tasks: [
      {
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
      },
    ],
    total: 1,
  },
}

describe('runList', () => {
  it('prints a human table on a TTY', async () => {
    const cap = capture(true)
    const io: CommandIo = {
      endpoint,
      fetchImpl: fakeFetch(taskListBody),
      stdout: cap.stdout,
    }
    await runList({}, io)
    expect(cap.text).toContain('ubuntu.iso')
    expect(cap.text).toContain('downloading')
    // human mode is not valid JSON
    expect(() => JSON.parse(cap.text)).toThrow()
  })

  it('prints a single JSON value when piped (non-TTY)', async () => {
    const cap = capture(false)
    const io: CommandIo = {
      endpoint,
      fetchImpl: fakeFetch(taskListBody),
      stdout: cap.stdout,
    }
    await runList({}, io)
    const parsed = JSON.parse(cap.text)
    expect(parsed.total).toBe(1)
    expect(parsed.tasks[0].id).toBe('task-1')
  })

  it('forwards status/limit/offset as task/list params', async () => {
    const cap = capture(true)
    const fetchImpl = fakeFetch(taskListBody)
    await runList(
      { status: 'downloading', limit: 10, offset: 2 },
      { endpoint, fetchImpl, stdout: cap.stdout }
    )
    const sent = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(sent.method).toBe('task/list')
    expect(sent.params).toEqual({ status: 'downloading', limit: 10, offset: 2 })
  })

  it('respects --json even on a TTY', async () => {
    const cap = capture(true)
    await runList(
      {},
      {
        endpoint,
        fetchImpl: fakeFetch(taskListBody),
        stdout: cap.stdout,
        json: true,
      }
    )
    expect(() => JSON.parse(cap.text)).not.toThrow()
  })
})

describe('runStats', () => {
  const statsBody = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      totalDownloadSpeed: 2048,
      totalUploadSpeed: 0,
      activeTasks: 2,
      waitingTasks: 1,
      stoppedTasks: 3,
    },
  }

  it('prints a human summary on a TTY', async () => {
    const cap = capture(true)
    await runStats({
      endpoint,
      fetchImpl: fakeFetch(statsBody),
      stdout: cap.stdout,
    })
    expect(cap.text.toLowerCase()).toContain('active')
  })

  it('prints JSON when piped', async () => {
    const cap = capture(false)
    await runStats({
      endpoint,
      fetchImpl: fakeFetch(statsBody),
      stdout: cap.stdout,
    })
    expect(JSON.parse(cap.text).activeTasks).toBe(2)
  })
})
