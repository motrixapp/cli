import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    'bin/motrix': 'src/bin/motrix.ts',
  },
  format: ['esm'],
  dts: false,
  splitting: false,
  clean: true,
  target: 'node20',
  platform: 'node',
  // @motrix/mdxp is published on npm, but we inline it into the built CLI
  // (a devDependency, not a runtime one) so the artifact stays self-contained
  // and `npm i -g @motrix/cli` pulls no @motrix/* runtime deps.
  // commander stays external (a normal npm runtime dependency).
  noExternal: [/^@motrix\//],
  banner: { js: '#!/usr/bin/env node' },
})
