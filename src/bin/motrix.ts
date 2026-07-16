// The `#!/usr/bin/env node` shebang is injected by tsup's `banner` config so
// the built dist/bin/motrix.js is directly executable; do NOT add one here too
// (a second shebang on line 2 is a syntax error).
import { runMain } from '../program'

runMain(process.argv)
