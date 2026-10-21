#!/usr/bin/env node
/**
 * Lists the licence of every crate in the sidecar's dependency tree and fails
 * on one that is not on the allow list. No GPL, LGPL or AGPL: the sidecar
 * ships as an executable, so a copyleft crate would bind the binary.
 *
 * Reads `cargo metadata`, so it needs no extra tool. `cargo deny check
 * licenses` (see native/deny.toml) is the stricter check for anyone who has it.
 *
 *   node scripts/check-licenses.mjs          # fail on a disallowed licence
 *   node scripts/check-licenses.mjs --list   # also print every crate
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWED = new Set([
	'MIT',
	'Apache-2.0',
	'Apache-2.0 WITH LLVM-exception',
	'BSD-2-Clause',
	'BSD-3-Clause',
	'ISC',
	'Unicode-3.0',
	'Zlib',
	'Unlicense',
	'CC0-1.0',
	'0BSD',
])

const r = spawnSync(
	'cargo',
	['metadata', '--format-version', '1', '--locked', '--manifest-path', join(root, 'native', 'Cargo.toml')],
	{ encoding: 'utf8', maxBuffer: 64 << 20 },
)
if (r.status !== 0) {
	console.error(r.stderr || r.error?.message)
	process.exit(1)
}
const meta = JSON.parse(r.stdout)

/** An SPDX expression is acceptable when its OR/AND structure is satisfied. */
function acceptable(expr) {
	const flat = expr.replace(/[()]/g, ' ').replace(/\//g, ' OR ')
	return flat.split(/\s+OR\s+/).some((alt) =>
		alt
			.split(/\s+AND\s+/)
			.map((t) => t.trim())
			.filter(Boolean)
			.every((t) => ALLOWED.has(t)),
	)
}

const own = new Set(meta.workspace_members)
const rows = meta.packages
	.filter((p) => !own.has(p.id))
	.map((p) => ({ name: p.name, version: p.version, license: p.license ?? '(none)' }))
	.sort((a, b) => a.name.localeCompare(b.name))

const bad = rows.filter((p) => !acceptable(p.license))
if (process.argv.includes('--list')) {
	for (const p of rows) console.log(`${p.name}@${p.version}\t${p.license}`)
}
console.log(`[analysis-native] ${rows.length} crates, ${bad.length} with a disallowed licence`)
for (const p of bad) console.error(`  ${p.name}@${p.version}: ${p.license}`)
process.exit(bad.length === 0 ? 0 : 1)
