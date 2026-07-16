import { describe, expect, it } from 'vitest'
import {
  type EndpointFile,
  endpointFilePath,
  resolveEndpoint,
  userDataDir,
} from './discovery'
import { CliError, EXIT } from './errors'

const aliveAlways = () => true
const deadAlways = () => false

const file: EndpointFile = {
  port: 16801,
  pid: 4242,
  localToken: 'file-token',
  writtenAt: 1,
}

describe('userDataDir', () => {
  it('resolves the macOS Application Support path', () => {
    expect(userDataDir('darwin', {}, '/Users/me')).toBe(
      '/Users/me/Library/Application Support/Motrix'
    )
  })

  it('resolves the Linux XDG config path', () => {
    expect(userDataDir('linux', {}, '/home/me')).toBe('/home/me/.config/Motrix')
  })

  it('honors XDG_CONFIG_HOME on Linux', () => {
    expect(userDataDir('linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/me')).toBe(
      '/cfg/Motrix'
    )
  })

  it('resolves the Windows APPDATA path', () => {
    expect(
      userDataDir('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:')
    ).toContain('Motrix')
  })
})

describe('endpointFilePath', () => {
  it('lands under <userData>/bridge/endpoint.json', () => {
    expect(endpointFilePath('darwin', {}, '/Users/me')).toBe(
      '/Users/me/Library/Application Support/Motrix/bridge/endpoint.json'
    )
  })
})

describe('resolveEndpoint — local discovery', () => {
  it('builds a loopback base URL + file token', () => {
    const r = resolveEndpoint(file, {}, aliveAlways)
    expect(r.baseUrl).toBe('http://127.0.0.1:16801')
    expect(r.token).toBe('file-token')
  })

  it('errors with NETWORK exit when no endpoint.json was found', () => {
    try {
      resolveEndpoint(null, {}, aliveAlways)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(CliError)
      expect((e as CliError).exitCode).toBe(EXIT.NETWORK)
    }
  })

  it('errors with NETWORK exit when the endpoint pid is dead (stale)', () => {
    try {
      resolveEndpoint(file, {}, deadAlways)
      expect.unreachable()
    } catch (e) {
      expect((e as CliError).exitCode).toBe(EXIT.NETWORK)
    }
  })
})

describe('resolveEndpoint — overrides', () => {
  it('uses --endpoint and --token, ignoring any local file', () => {
    const r = resolveEndpoint(
      file,
      { endpoint: 'http://nas.local:16801/', token: 'remote-tok' },
      deadAlways // a dead local pid must not matter when --endpoint is set
    )
    expect(r.baseUrl).toBe('http://nas.local:16801')
    expect(r.token).toBe('remote-tok')
  })

  it('does NOT fall back to the local file token for a remote --endpoint', () => {
    try {
      resolveEndpoint(file, { endpoint: 'http://nas.local:16801' }, aliveAlways)
      expect.unreachable()
    } catch (e) {
      expect((e as CliError).exitCode).toBe(EXIT.USAGE)
    }
  })

  it('prefers an explicit env token over the file token', () => {
    const r = resolveEndpoint(file, { envToken: 'env-tok' }, aliveAlways)
    expect(r.token).toBe('env-tok')
  })

  it('uses a stored credential token for a remote endpoint', () => {
    const r = resolveEndpoint(
      file,
      { endpoint: 'http://nas.local:16801', credentialsToken: 'paired-tok' },
      deadAlways
    )
    expect(r.baseUrl).toBe('http://nas.local:16801')
    expect(r.token).toBe('paired-tok')
  })

  it('prefers --token over a stored credential token', () => {
    const r = resolveEndpoint(
      file,
      {
        endpoint: 'http://nas.local:16801',
        token: 'explicit',
        credentialsToken: 'paired-tok',
      },
      deadAlways
    )
    expect(r.token).toBe('explicit')
  })
})
