import { describe, expect, it, vi } from 'vitest'
import { EXIT } from '../errors'
import { runAdd } from './add'
import { runPause, runRemove, runResume } from './lifecycle'

const endpoint = { baseUrl: 'http://127.0.0.1:16801', token: 'tok' }

function fakeFetch(result: unknown) {
  return vi.fn().mockResolvedValue({
    status: 200,
    json: async () => ({ jsonrpc: '2.0', id: 1, result }),
  } as Response)
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

const createdTask = {
  id: 'task-1',
  type: 'http',
  name: 'f.iso',
  status: 'queued',
  progress: 0,
  bytesDone: 0,
  bytesTotal: null,
  speedBps: 0,
  etaSec: null,
  saveDir: '/dl',
  error: null,
  createdAt: 0,
  finishedAt: null,
  finalPath: null,
}

function sent(fetchImpl: ReturnType<typeof vi.fn>) {
  return JSON.parse(fetchImpl.mock.calls[0][1].body)
}

describe('runAdd — url', () => {
  it('submits a url download/add and prints the created task', async () => {
    const cap = capture(true)
    const fetchImpl = fakeFetch(createdTask)
    await runAdd(
      ['https://example.com/f.iso'],
      {
        saveDir: '/dl',
        connections: 8,
        header: ['Referer: https://example.com'],
      },
      { endpoint, fetchImpl, stdout: cap.stdout }
    )
    const body = sent(fetchImpl)
    expect(body.method).toBe('download/add')
    expect(body.params).toEqual({
      kind: 'url',
      saveDir: '/dl',
      uris: ['https://example.com/f.iso'],
      connections: 8,
      headers: [{ name: 'Referer', value: 'https://example.com' }],
    })
    expect(cap.text).toContain('task-1')
  })

  it('errors USAGE when --save-dir is missing', async () => {
    const cap = capture(true)
    await expect(
      runAdd(
        ['https://example.com/f.iso'],
        {},
        { endpoint, stdout: cap.stdout }
      )
    ).rejects.toMatchObject({ exitCode: EXIT.USAGE })
  })

  it('errors USAGE on an unsupported URL scheme (client-side gate)', async () => {
    const cap = capture(true)
    await expect(
      runAdd(
        ['file:///etc/passwd'],
        { saveDir: '/dl' },
        { endpoint, stdout: cap.stdout }
      )
    ).rejects.toMatchObject({ exitCode: EXIT.USAGE })
  })

  it('errors USAGE when no url / --magnet / --torrent is given', async () => {
    const cap = capture(true)
    await expect(
      runAdd([], { saveDir: '/dl' }, { endpoint, stdout: cap.stdout })
    ).rejects.toMatchObject({ exitCode: EXIT.USAGE })
  })
})

describe('runAdd — magnet', () => {
  it('submits a magnet with an optional --select', async () => {
    const cap = capture(false)
    const fetchImpl = fakeFetch(createdTask)
    await runAdd(
      [],
      { saveDir: '/dl', magnet: 'magnet:?xt=urn:btih:abc', select: '0,2' },
      { endpoint, fetchImpl, stdout: cap.stdout }
    )
    expect(sent(fetchImpl).params).toEqual({
      kind: 'magnet',
      saveDir: '/dl',
      uri: 'magnet:?xt=urn:btih:abc',
      selectedFiles: [0, 2],
    })
  })
})

describe('runAdd — torrent', () => {
  it('reads the file, base64-encodes it, and submits a torrent add', async () => {
    const cap = capture(false)
    const fetchImpl = fakeFetch(createdTask)
    const readFile = vi.fn(async () => Buffer.from('torrentbytes'))
    await runAdd(
      [],
      { saveDir: '/dl', torrent: '/tmp/x.torrent' },
      { endpoint, fetchImpl, stdout: cap.stdout },
      readFile
    )
    expect(readFile).toHaveBeenCalledWith('/tmp/x.torrent')
    const params = sent(fetchImpl).params
    expect(params.kind).toBe('torrent')
    expect(params.base64).toBe(Buffer.from('torrentbytes').toString('base64'))
  })

  it('maps an unreadable torrent file to a USAGE exit, not a crash', async () => {
    const cap = capture(false)
    const readFile = vi.fn(async () => {
      throw new Error('ENOENT: no such file')
    })
    await expect(
      runAdd(
        [],
        { saveDir: '/dl', torrent: '/tmp/missing.torrent' },
        { endpoint, fetchImpl: fakeFetch(createdTask), stdout: cap.stdout },
        readFile
      )
    ).rejects.toMatchObject({ exitCode: EXIT.USAGE })
  })
})

describe('lifecycle commands', () => {
  it('runPause sends task/pause', async () => {
    const cap = capture(false)
    const fetchImpl = fakeFetch({ ok: true })
    await runPause('task-1', { endpoint, fetchImpl, stdout: cap.stdout })
    expect(sent(fetchImpl).method).toBe('task/pause')
    expect(sent(fetchImpl).params).toEqual({ taskId: 'task-1' })
    expect(JSON.parse(cap.text)).toEqual({ ok: true })
  })

  it('runResume sends task/resume', async () => {
    const cap = capture(false)
    const fetchImpl = fakeFetch({ ok: true })
    await runResume('task-1', { endpoint, fetchImpl, stdout: cap.stdout })
    expect(sent(fetchImpl).method).toBe('task/resume')
  })

  it('runRemove sends task/remove with deleteFiles', async () => {
    const cap = capture(false)
    const fetchImpl = fakeFetch({ ok: true })
    await runRemove(
      'task-1',
      { deleteFiles: true },
      { endpoint, fetchImpl, stdout: cap.stdout }
    )
    expect(sent(fetchImpl).method).toBe('task/remove')
    expect(sent(fetchImpl).params).toEqual({
      taskId: 'task-1',
      deleteFiles: true,
    })
  })

  it('runRemove omits deleteFiles when not requested', async () => {
    const cap = capture(false)
    const fetchImpl = fakeFetch({ ok: true })
    await runRemove('task-1', {}, { endpoint, fetchImpl, stdout: cap.stdout })
    expect(sent(fetchImpl).params).toEqual({ taskId: 'task-1' })
  })
})
