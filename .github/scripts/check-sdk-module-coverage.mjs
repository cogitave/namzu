#!/usr/bin/env node
/**
 * Per-module coverage floor gate for @namzu/sdk.
 *
 * Reads `packages/sdk/coverage/coverage-summary.json` (produced by
 * `pnpm --filter @namzu/sdk test:coverage`) and `packages/sdk/coverage-config.json`.
 *
 * For every module listed in `coverageFloors`, aggregates line + branch
 * coverage across every source file under `packages/sdk/src/<module>/**`
 * and asserts the aggregate is ≥ the floor. Fails with a per-module
 * breakdown on regression.
 *
 * Why aggregate per module, not per file: a module's invariants are
 * defended by the test set as a whole. Per-file floors would force
 * awkward padding in small helper files. Per-module floors measure the
 * property we actually care about: "this module's behavior is under test."
 *
 * Floor policy (ses_006 §9, Q6.1 refinement): floors are set from
 * measurement, not guessed. Each module phase lands tests, measures,
 * then sets floor = measured − 3 (slack for small future edits).
 *
 * Non-bypassable by design (ses_006 Q7); there is no env-var escape hatch.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, sep } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const sdkRoot = join(repoRoot, 'packages', 'sdk')
const configPath = join(sdkRoot, 'coverage-config.json')
const summaryPath = join(sdkRoot, 'coverage', 'coverage-summary.json')

if (!existsSync(summaryPath)) {
	console.error(`✗ coverage summary not found at ${summaryPath}`)
	console.error('  Run: pnpm --filter @namzu/sdk test:coverage')
	process.exit(1)
}

const config = JSON.parse(readFileSync(configPath, 'utf8'))
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
const floors = config.coverageFloors ?? {}

/**
 * `coverage-summary.json` is a flat map keyed by absolute source path;
 * each entry has `lines`, `statements`, `functions`, `branches` blocks.
 * We aggregate totals/covered across files matching a module prefix,
 * then compute pct in one place to avoid averaging-of-averages error.
 */
function aggregateForModule(moduleName) {
	const prefix = join(sdkRoot, 'src', moduleName) + sep
	const lines = { total: 0, covered: 0 }
	const branches = { total: 0, covered: 0 }
	let fileCount = 0

	for (const [filePath, entry] of Object.entries(summary)) {
		if (filePath === 'total') continue
		if (!filePath.startsWith(prefix)) continue
		fileCount += 1
		lines.total += entry.lines?.total ?? 0
		lines.covered += entry.lines?.covered ?? 0
		branches.total += entry.branches?.total ?? 0
		branches.covered += entry.branches?.covered ?? 0
	}

	const linePct = lines.total === 0 ? 0 : (lines.covered / lines.total) * 100
	const branchPct = branches.total === 0 ? 0 : (branches.covered / branches.total) * 100
	return { fileCount, lines, branches, linePct, branchPct }
}

let failed = false
const rows = []

for (const [moduleName, floor] of Object.entries(floors)) {
	const agg = aggregateForModule(moduleName)
	const lineOk = agg.linePct >= floor.line
	const branchOk = agg.branchPct >= floor.branch
	const rowFailed = !lineOk || !branchOk
	if (rowFailed) failed = true
	rows.push({ moduleName, floor, agg, lineOk, branchOk, rowFailed })
}

// Compact table output.
const pad = (s, n) => String(s).padEnd(n)
const header = `${pad('module', 10)} ${pad('files', 5)} ${pad('lines', 22)} ${pad('branches', 22)}`
console.log(header)
console.log('-'.repeat(header.length))
for (const row of rows) {
	const { moduleName, floor, agg, lineOk, branchOk, rowFailed } = row
	const lineStr = `${agg.linePct.toFixed(1)}% / ${floor.line}%${lineOk ? ' ✓' : ' ✗'}`
	const branchStr = `${agg.branchPct.toFixed(1)}% / ${floor.branch}%${branchOk ? ' ✓' : ' ✗'}`
	const marker = rowFailed ? '  ← FAIL' : ''
	console.log(`${pad(moduleName, 10)} ${pad(agg.fileCount, 5)} ${pad(lineStr, 22)} ${pad(branchStr, 22)}${marker}`)
}

if (failed) {
	console.error('\n✗ per-module coverage floor breach. See rows marked FAIL above.')
	console.error('  Floors live in packages/sdk/coverage-config.json (ses_006).')
} else {
	console.log('\n✓ per-module coverage floor gate passed')
}

process.exit(failed ? 1 : 0)
