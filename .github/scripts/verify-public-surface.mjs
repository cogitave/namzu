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
	const exported = checker.getExportsOfModule(moduleSymbol)
	return {
		names: exported.map((symbol) => symbol.getName()).sort(),
		// The checker has already resolved every symbol, so its JSDoc tags come
		// for free — no second program, no second parse.
		//
		// This is the view that makes a deprecation wave auditable. The runtime
		// and declared lists are bare names, so a transitional alias and a
		// permanent export look identical the moment the baseline is
		// regenerated. Worse, SemVer rule 8's requirement is specifically that
		// the OLD name carries `@deprecated` — and without this, an alias could
		// ship with the tag omitted and every gate would report the surface
		// intact. The gate would be true about the names and silent about the
		// only property the rule is written around.
		//
		// Resolved THROUGH the alias. `index.d.ts` is a barrel over barrels, so
		// almost every name here is an alias symbol, and an alias carries only
		// the tags written on the re-export specifier itself -- not the ones on
		// the declaration it points at. Reading `getJsDocTags()` off the alias
		// alone therefore saw a deprecation only when it happened to be marked
		// at the LAST hop, and missed every one marked where the thing is
		// actually declared. `mapSessionToStreamEvent` is the case that showed
		// it: `bridge/sse/mapper.ts` marks it correctly, the tag survives into
		// `mapper.d.ts`, and the gate reported the surface intact.
		deprecated: exported
			.filter((symbol) => isDeprecated(symbol, checker))
			.map((symbol) => symbol.getName())
			.sort(),
	}
}

/**
 * Does this exported name carry `@deprecated`, at the alias or at the
 * declaration it resolves to?
 *
 * Either counts. A name deprecated at its declaration is deprecated for
 * every consumer that reaches it through a barrel, and a name deprecated
 * only on one re-export specifier is deprecated for consumers of THAT
 * entry point -- which is the public one. Requiring both would let a
 * correct deprecation go unrecorded; requiring the alias only did.
 */
function isDeprecated(symbol, checker) {
	if (symbol.getJsDocTags().some((tag) => tag.name === 'deprecated')) return true
	if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return false
	// `getAliasedSymbol` throws rather than returning undefined when the
	// symbol is not an alias, which the guard above already excludes; it can
	// still fail on a broken resolution, and a gate that dies on one symbol
	// reports nothing about the other 1300.
	try {
		return checker.getAliasedSymbol(symbol).getJsDocTags().some((tag) => tag.name === 'deprecated')
	} catch {
		return false
	}
}

const declared = declaredExports()
const currentDeclared = declared.names
const currentDeprecated = declared.deprecated

if (process.argv.includes('--write')) {
	writeFileSync(
		baselinePath,
		`${JSON.stringify({ runtime: currentRuntime, declared: currentDeclared, deprecated: currentDeprecated }, null, 2)}\n`,
	)
	console.log(
		`baseline written: ${currentRuntime.length} runtime, ${currentDeclared.length} declared, ${currentDeprecated.length} deprecated`,
	)
	process.exit(0)
}

const raw = JSON.parse(readFileSync(baselinePath, 'utf8'))
// The baseline was a bare array of runtime names before the declared view
// existed. Reading that shape still works, and reports the declared view as
// entirely new — which is the correct thing to say about a surface nothing
// had recorded.
const baseline = Array.isArray(raw) ? { runtime: raw, declared: [], deprecated: [] } : raw

const VIEWS = [
	{ label: 'runtime', baseline: baseline.runtime ?? [], current: currentRuntime },
	{ label: 'declared', baseline: baseline.declared ?? [], current: currentDeclared },
	// Both directions fail, and both should. ADDING a deprecation is a surface
	// decision — it announces a removal — and REMOVING one is the louder half:
	// it un-announces a removal consumers may already be migrating for.
	{ label: 'deprecated', baseline: baseline.deprecated ?? [], current: currentDeprecated },
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
