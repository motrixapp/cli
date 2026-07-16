import { describe, expect, it } from 'vitest'
import { compareSemver, pickHighest } from './semver'

describe('compareSemver', () => {
  it('orders by major/minor/patch numerically', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1)
    expect(compareSemver('0.10.0', '0.9.9')).toBe(1)
    expect(compareSemver('0.2.1', '0.2.1')).toBe(0)
  })

  it('sorts a prerelease before its release', () => {
    expect(compareSemver('1.0.0-beta.1', '1.0.0')).toBe(-1)
    expect(compareSemver('1.0.0', '1.0.0-rc.0')).toBe(1)
  })

  it('compares prerelease identifiers per SemVer §11', () => {
    expect(compareSemver('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1) // numeric
    expect(compareSemver('1.0.0-alpha', '1.0.0-beta')).toBe(-1) // lexical
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1) // shorter set
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1) // numeric < alpha
  })
})

describe('pickHighest', () => {
  it('picks the highest of a range result', () => {
    expect(pickHighest(['0.1.0', '0.2.1', '0.2.0'])).toBe('0.2.1')
  })

  it('returns null for an empty list', () => {
    expect(pickHighest([])).toBe(null)
  })
})
