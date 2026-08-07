#!/usr/bin/env node
/**
 * Public-surface regression guard for @namzu/sdk.
 *
 * Compares two views of the built root barrel against a recorded baseline:
 *
 *  - **runtime** — `Object.keys()` of `dist/index.js`. Catches dropped error
 *    classes, schemas, and side-effect import chains that a `.d.ts` text diff
 *    reads straight past.
 *  - **declared** — every export of `dist/index.d.ts`, resolved through the
 *    TypeScript checker. Catches the other half.
 *
 * The declared view was added after this gate let a public type removal go by
 * unremarked. `Object.keys()` sees values; an `export type` or
 * `export interface` is erased before it ever reaches a runtime module object.
 * At the time that was found, 496 names were under the gate and 1155 were
 * exported — so more than half of what a consumer can import had never been
 * guarded at all, in an SDK whose public API is mostly types. `ToolCatalogSurface`
 * could be deleted, and was, with the gate reporting the surface intact.
 *
 * Both directions fail. A name that disappears is a break; a name that appears
 * and is never recorded is invisible to the removal check, because the check
 * compares `baseline - current`. That is not theoretical:
 * `classifyProviderHttpStatus` and `bodySaysContextOverflow` were added to the
 * surface, never entered the baseline, were dropped by a merge, and shipped
 * missing in a major while this gate reported no problem.
 *
 * Baseline captured at the tip of commit f8cb129 (the final commit of
 * ses_010-sdk-type-layering, pre-ses_011).
 *
 * Extension: if a commit intentionally changes the public surface, regenerate
 * the baseline in that same commit:
 *
 *   pnpm --filter @namzu/sdk build
 *   node .github/scripts/verify-public-surface.mjs --write
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'

const __dirname = dirname(fileURLToPath(import.meta.url))
const baselinePath = join(__dirname, 'public-surface-baseline.json')
const distDir = join(__dirname, '..', '..', 'packages', 'sdk', 'dist')
const sdkDistPath = join(distDir, 'index.js')
const sdkTypesPath = join(distDir, 'index.d.ts')

/** Runtime exports: what survives to a module object. */
// `import()` of an absolute path only works on POSIX; on Windows a bare
// `C:\...` is parsed as a URL scheme. Go through a file:// URL so the gate is
// runnable locally on every platform, not just in CI.
const sdk = await import(pathToFileURL(sdkDistPath).href)
const currentRuntime = Object.keys(sdk).sort()

/**
 * Declared exports: values AND types, as a consumer sees them.
 *
 * Resolved through the checker rather than parsed out of the `.d.ts` text.
 * The barrel is a chain of `export * from` / `export type * from`, so a
 * regex would have to re-implement module resolution to follow it, and would
 * report whatever it failed to follow as "absent" — a gate that fails open.
 */
function declaredExports() {
	const program = ts.createProgram([sdkTypesPath], {
		noEmit: true,
		skipLibCheck: true,
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
	})
	const source = program.getSourceFile(sdkTypesPath)
	if (!source) throw new Error(`Could not load ${sdkTypesPath} — run the SDK build first.`)
	const checker = program.getTypeChecker()
	const moduleSymbol = checker.getSymbolAtLocation(source)
	if (!moduleSymbol) throw new Error(`${sdkTypesPath} resolved to no module symbol.`)
	return checker
		.getExportsOfModule(moduleSymbol)
		.map((symbol) => symbol.getName())
		.sort()
}

const currentDeclared = declaredExports()

if (process.argv.includes('--write')) {
	writeFileSync(
		baselinePath,
		`${JSON.stringify({ runtime: currentRuntime, declared: currentDeclared }, null, 2)}\n`,
	)
	console.log(
		`baseline written: ${currentRuntime.length} runtime, ${currentDeclared.length} declared`,
	)
	process.exit(0)
}

const raw = JSON.parse(readFileSync(baselinePath, 'utf8'))
// The baseline was a bare array of runtime names before the declared view
// existed. Reading that shape still works, and reports the declared view as
// entirely new — which is the correct thing to say about a surface nothing
// had recorded.
const baseline = Array.isArray(raw) ? { runtime: raw, declared: [] } : raw

const VIEWS = [
	{ label: 'runtime', baseline: baseline.runtime ?? [], current: currentRuntime },
	{ label: 'declared', baseline: baseline.declared ?? [], current: currentDeclared },
]

let failed = false

for (const view of VIEWS) {
	console.log(`${view.label}: baseline ${view.baseline.length}, current ${view.current.length}`)

	const missing = view.baseline.filter((name) => !view.current.includes(name))
	const added = view.current.filter((name) => !view.baseline.includes(name))

	if (missing.length > 0) {
		console.error(`\n✗ PUBLIC-SURFACE REGRESSION (${view.label}) — ${missing.length} names dropped:`)
		for (const name of missing) console.error(`  - ${name}`)
		failed = true
	}

	if (added.length > 0) {
		console.error(`\n✗ PUBLIC-SURFACE WIDENED (${view.label}) — ${added.length} names added:`)
		for (const name of added) console.error(`  - ${name}`)
		failed = true
	}
}

if (failed) {
	console.error(
		'\n  Regenerate the baseline in this commit:\n' +
			'    pnpm --filter @namzu/sdk build\n' +
			'    node .github/scripts/verify-public-surface.mjs --write\n' +
			'\n  Widening fails rather than warns because a name outside the baseline\n' +
			'  is invisible to the removal check: it compares `baseline - current`, so\n' +
			'  anything added and never recorded can be deleted later and still read\n' +
			'  as "intact".',
	)
	process.exit(1)
}

console.log('\n✓ public surface intact')
