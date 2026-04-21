#!/usr/bin/env node
/**
 * Public-surface regression guard for @namzu/sdk.
 *
 * Loads every key exported by the built `@namzu/sdk` root barrel and
 * compares against the baseline captured at the tip of commit f8cb129
 * (the final commit of ses_010-sdk-type-layering, pre-ses_011).
 *
 * Fails if any baseline name disappears from the public surface.
 *
 * Why this exists: `.d.ts` text diffs catch type-name regressions but do
 * not catch runtime-only regressions (dropped error classes, schemas,
 * side-effect import chains). ses_011's four-commit barrel refactor is
 * the first time we moved ~380 public names to new home files; without
 * this guard, a missed `export` inside `public-runtime.ts` ships silent
 * breakage. See
 * `docs.local/sessions/ses_011-sdk-public-surface/design.md#4.5`.
 *
 * Extension: if a commit intentionally widens the public surface, regenerate
 * the baseline via:
 *
 *   cd packages/sdk && pnpm build
 *   node --input-type=module --eval "\
 *     import('./dist/index.js').then(s => { \
 *       const names = Object.keys(s).sort(); \
 *       require('node:fs').writeFileSync( \
 *         '../../.github/scripts/public-surface-baseline.json', \
 *         JSON.stringify(names, null, 2) + '\\n' \
 *       ); \
 *     })"
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const baselinePath = join(__dirname, 'public-surface-baseline.json')
const sdkDistPath = join(__dirname, '..', '..', 'packages', 'sdk', 'dist', 'index.js')

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
const sdk = await import(sdkDistPath)
const current = Object.keys(sdk).sort()

const missing = baseline.filter((name) => !current.includes(name))
const added = current.filter((name) => !baseline.includes(name))

console.log(`baseline: ${baseline.length} names`)
console.log(`current:  ${current.length} names`)

let failed = false

if (missing.length > 0) {
	console.error(`\n✗ PUBLIC-SURFACE REGRESSION — ${missing.length} names dropped:`)
	for (const name of missing) console.error(`  - ${name}`)
	failed = true
}

if (added.length > 0) {
	console.error(`\n⚠ PUBLIC-SURFACE WIDENED — ${added.length} names added (review intent):`)
	for (const name of added) console.error(`  - ${name}`)
	// Additions are warnings, not failures. Intentional widenings update the
	// baseline in the same commit; silent drift is caught by reviewer.
}

if (failed) process.exit(1)
console.log('\n✓ public surface intact')
