import { describe, expect, it } from 'vitest'
import { openerFor } from './launch'

describe('openerFor', () => {
  it('uses `open` on macOS', () => {
    expect(openerFor('darwin')).toEqual({ cmd: 'open', args: [] })
  })

  it('uses `cmd /c start ""` on Windows', () => {
    expect(openerFor('win32')).toEqual({
      cmd: 'cmd',
      args: ['/c', 'start', ''],
    })
  })

  it('uses `xdg-open` on Linux and other platforms', () => {
    expect(openerFor('linux')).toEqual({ cmd: 'xdg-open', args: [] })
  })
})
