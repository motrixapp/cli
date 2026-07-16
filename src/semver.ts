/**
 * Minimal semver ordering for the self-update guards — `x.y.z` plus an
 * optional prerelease (`-alpha.1`): a prerelease sorts before its release,
 * identifiers compare segment-wise (numeric when both numeric, SemVer §11).
 * Build metadata (`+…`) is not handled — npm never serves two published
 * versions differing only by build metadata. Not a range evaluator: range
 * SPECS are resolved by `npm view`; this only orders concrete versions.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  const as = pa.pre.split('.')
  const bs = pb.pre.split('.')
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i]
    const y = bs[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const dx = Number(x)
      const dy = Number(y)
      if (dx !== dy) return dx < dy ? -1 : 1
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** Highest version under compareSemver; null for an empty list. */
export function pickHighest(versions: string[]): string | null {
  let best: string | null = null
  for (const v of versions) {
    if (best === null || compareSemver(v, best) > 0) best = v
  }
  return best
}

function parse(v: string): {
  nums: [number, number, number]
  pre: string | null
} {
  const dash = v.indexOf('-')
  const core = dash === -1 ? v : v.slice(0, dash)
  const pre = dash === -1 ? null : v.slice(dash + 1)
  const segs = core.split('.').map((n) => {
    const x = Number.parseInt(n, 10)
    return Number.isNaN(x) ? 0 : x
  })
  return { nums: [segs[0] ?? 0, segs[1] ?? 0, segs[2] ?? 0], pre }
}
