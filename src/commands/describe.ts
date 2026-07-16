import { toAgentToolCatalog } from '@motrix/mdxp'
import { wantsJson } from '../output'

export interface DescribeContext {
  stdout: { write(s: string): unknown; isTTY?: boolean }
  json?: boolean
}

/**
 * Print the MDXP agent-tool catalog — the machine-readable contract an AI agent
 * (or an MCP shim) consumes to learn the callable surface + input/output
 * schemas. Static: reads the bundled `Tools` registry via `toAgentToolCatalog`,
 * no bridge connection, so it can never drift from what the CLI actually calls.
 */
export function runDescribe(ctx: DescribeContext): void {
  const catalog = toAgentToolCatalog()
  if (wantsJson({ json: ctx.json }, ctx.stdout)) {
    ctx.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`)
    return
  }
  const rows = catalog.map((t) => {
    const req = (t.inputSchema as { required?: unknown }).required
    const required = Array.isArray(req) && req.length ? req.join(', ') : '—'
    return `  ${t.name.padEnd(16)} ${t.description}\n  ${' '.repeat(16)} required: ${required}`
  })
  ctx.stdout.write(
    `Motrix MDXP tool catalog — ${catalog.length} agent-callable methods\n` +
      'Run `motrix describe --json` for the full JSON-Schema input/output.\n\n' +
      `${rows.join('\n')}\n`
  )
}
