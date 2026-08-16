#!/usr/bin/env node
/**
 * Public-surface regression guard for every publishable package.
 *
 * Compares two views of each built entry point against a recorded baseline:
 *
 *  - **runtime** — `Object.keys()` of the built module. Catches dropped error
 *    classes, schemas, and side-effect import chains that a `.d.ts` text diff
 *    reads straight past.
 *  - **declared** — every export of the matching `.d.ts`, resolved through the
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
 * ## Every package, and every entry point in it
 *
 * This guarded exactly one entry point — `@namzu/sdk`'s `.` — while fifteen
 * packages publish to npm. Thirteen others had no surface check of any kind,
 * and two more entry points inside the guarded packages had none either,
 * including the SDK's own `./testing`.
 *
 * Per-entry-point rather than per-package because a package's surface is not
 * its root barrel. `@namzu/files` exports **one** name from `.` and the rest
 * of its API from subpaths (`./inmem`, `./local`, `./azure-blob`, `./http`). A
 * gate that recorded only `.` for that package would guard one name, report
 * the surface intact for every possible change to the others, and read in CI
 * exactly like a gate that worked — `a-check-that-cannot-fail`.
 *
 * A package with no non-glob `exports` entry is recorded as having no
 * guardable entry point rather than skipped in silence: `@namzu/evals`
 * publishes eval suites under `./kernel/*` and `./security/*` and has no JS
 * API at all, which is a fact worth stating in the baseline instead of
 * leaving a reader to wonder whether it was forgotten.
 *
 * Extension: if a commit intentionally changes the public surface, regenerate
 * the baseline in that same commit:
 *
 *   pnpm -r build
 *   node .github/scripts/verify-public-surface.mjs --write
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const baselinePath = join(__dirname, 'public-surface-baseline.json')

/**
 * Publishable packages, at both nesting depths.
 *
 * `packages/<pkg>` and `packages/<group>/<pkg>` are the two shapes this repo
 * has; the descent stops at two so it cannot wander into a nested
 * `node_modules`. `private: true` is the same signal `pnpm publish` reads, so
 * this list cannot drift from what actually ships.
 */
function publishablePackages() {
	const found = []
	const packagesDir = join(repoRoot, 'packages')
	for (const name of readdirSync(packagesDir)) {
		if (name === 'node_modules') continue
		const dir = join(packagesDir, name)
		if (!isDirectory(dir)) continue
		if (existsSync(join(dir, 'package.json'))) {
			pushIfPublishable(found, dir)
			continue
		}
		for (const nested of readdirSync(dir)) {
			if (nested === 'node_modules') continue
			const nestedDir = join(dir, nested)
			if (isDirectory(nestedDir) && existsSync(join(nestedDir, 'package.json'))) {
				pushIfPublishable(found, nestedDir)
			}
		}
	}
	return found.sort((a, b) => a.name.localeCompare(b.name))
}

function pushIfPublishable(found, dir) {
	const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
	if (manifest.private) return
	found.push({ name: manifest.name, dir, manifest })
}

function isDirectory(path) {
	try {
		return statSync(path).isDirectory()
	} catch {
		return false
	}
}

/**
 * The entry points of one package, as a consumer can import them.
 *
 * Read off `exports` rather than assumed to be `dist/index.js`, because the
 * manifest is what Node resolves against and a package that moves its entry
 * would otherwise be guarded at a path nobody can import.
 *
 * Skipped, each for a stated reason:
 *  - a glob subpath (`./kernel/*`) — the set is open, so there is no fixed
 *    surface to record;
 *  - `./package.json`, which every package exports so tooling can read it and
 *    which is not a module;
 *  - a subpath whose `import` condition names a file that is not `.js`.
 */
function entryPoints(pkg) {
	const exportsField = pkg.manifest.exports
	if (!exportsField || typeof exportsField !== 'object') return []
	const out = []
	for (const [subpath, condition] of Object.entries(exportsField)) {
		if (subpath.includes('*') || subpath === './package.json') continue
		const js = typeof condition === 'string' ? condition : condition?.import ?? condition?.default
		const types = typeof condition === 'string' ? undefined : condition?.types
		if (typeof js !== 'string' || !js.endsWith('.js')) continue
		out.push({
			subpath,
			js: resolve(pkg.dir, js),
			// A package may ship types beside the JS without a `types`
			// condition; try the sibling `.d.ts` before giving up, so the
			// declared view is not silently empty for it.
			types: resolve(pkg.dir, typeof types === 'string' ? types : js.replace(/\.js$/, '.d.ts')),
		})
	}
	return out
}

/** Runtime exports: what survives to a module object. */
// `import()` of an absolute path only works on POSIX; on Windows a bare
// `C:\...` is parsed as a URL scheme. Go through a file:// URL so the gate is
// runnable locally on every platform, not just in CI.
async function runtimeExports(jsPath) {
	const module = await import(pathToFileURL(jsPath).href)
	return Object.keys(module).sort()
}

/**
 * Declared exports: values AND types, as a consumer sees them.
 *
 * Resolved through the checker rather than parsed out of the `.d.ts` text.
 * The barrel is a chain of `export * from` / `export type * from`, so a
 * regex would have to re-implement module resolution to follow it, and would
 * report whatever it failed to follow as "absent" — a gate that fails open.
 */
function declaredExports(typesPath) {
	if (!existsSync(typesPath)) return { names: [], deprecated: [] }
	const program = ts.createProgram([typesPath], {
		noEmit: true,
		skipLibCheck: true,
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
	})
	const source = program.getSourceFile(typesPath)
	if (!source) throw new Error(`Could not load ${typesPath} — run the build first.`)
	const checker = program.getTypeChecker()
	const moduleSymbol = checker.getSymbolAtLocation(source)
	if (!moduleSymbol) throw new Error(`${typesPath} resolved to no module symbol.`)
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

const packages = publishablePackages()
/** @type {Record<string, Record<string, {runtime: string[], declared: string[], deprecated: string[]}>>} */
const current = {}
const unbuilt = []

for (const pkg of packages) {
	const entries = entryPoints(pkg)
	current[pkg.name] = {}
	for (const entry of entries) {
		if (!existsSync(entry.js)) {
			unbuilt.push(`${pkg.name} ${entry.subpath} -> ${entry.js}`)
			continue
		}
		const declared = declaredExports(entry.types)
		current[pkg.name][entry.subpath] = {
			runtime: await runtimeExports(entry.js),
			declared: declared.names,
			deprecated: declared.deprecated,
		}
	}
}

/**
 * An entry point a consumer can import that hands them nothing.
 *
 * `@namzu/files` published `./postgres`, `./s3` and `./gcs` at 0.2.1 with
 * `export {}` behind each — placeholders for adapters that had not been
 * written. The import RESOLVES, so a reader gets no error and no module
 * either: `import { S3BlobStore } from '@namzu/files/s3'` is `undefined` at
 * runtime, discovered wherever it is first called.
 *
 * Distinct from the zero-byte check in `check-publish-metadata.mjs`, which
 * these passed at 44 bytes each. That one asks whether a file has content;
 * this asks whether an ENTRY POINT has a surface, which is the question a
 * consumer is really asking when they write the import.
 *
 * A package with no guardable entry point at all — `@namzu/evals` — is a
 * different statement and is not caught here: it declares no `.`, so nobody
 * can import it expecting one.
 */
const hollow = []
for (const [pkgName, byEntry] of Object.entries(current))
	for (const [subpath, view] of Object.entries(byEntry))
		if (view.runtime.length === 0 && view.declared.length === 0)
			hollow.push(`${pkgName}${subpath === '.' ? '' : subpath.slice(1)}`)

if (hollow.length > 0) {
	console.error(`\n✗ ${hollow.length} entry point(s) resolve to nothing:`)
	for (const name of hollow) console.error(`  - ${name}`)
	console.error(
		'\n  A consumer importing one gets no error and no module. Remove the subpath from\n' +
			'  `exports` until it has something to export, or give it the surface its name implies.',
	)
	process.exit(1)
}

// A missing build output is not "no exports" — recording it as an empty
// surface would let the next run compare against nothing and pass. Refuse.
if (unbuilt.length > 0) {
	console.error(`\n✗ ${unbuilt.length} entry point(s) are not built:`)
	for (const line of unbuilt) console.error(`  - ${line}`)
	console.error('\n  Run `pnpm -r build` first. This gate reads the BUILT surface, not the source.')
	process.exit(1)
}

const totals = () => {
	let entries = 0
	let runtime = 0
	let declared = 0
	let deprecated = 0
	for (const byEntry of Object.values(current))
		for (const view of Object.values(byEntry)) {
			entries += 1
			runtime += view.runtime.length
			declared += view.declared.length
			deprecated += view.deprecated.length
		}
	return { entries, runtime, declared, deprecated }
}

if (process.argv.includes('--write')) {
	writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`)
	const t = totals()
	console.log(
		`baseline written: ${Object.keys(current).length} packages, ${t.entries} entry points, ` +
			`${t.runtime} runtime, ${t.declared} declared, ${t.deprecated} deprecated`,
	)
	process.exit(0)
}

const raw = JSON.parse(readFileSync(baselinePath, 'utf8'))
// The baseline was a bare array of runtime names, and then a flat
// {runtime, declared, deprecated} object — both of which described the SDK's
// root entry and nothing else. Reading either still works and reports every
// other entry point as entirely new, which is the correct thing to say about
// a surface nothing had recorded.
const baseline = Array.isArray(raw)
	? { '@namzu/sdk': { '.': { runtime: raw, declared: [], deprecated: [] } } }
	: Array.isArray(raw.runtime)
		? { '@namzu/sdk': { '.': { runtime: raw.runtime, declared: raw.declared ?? [], deprecated: raw.deprecated ?? [] } } }
		: raw

let failed = false

// Every package/entry point on EITHER side, so a package that vanishes from
// the baseline's point of view is reported rather than iterated past.
const packageNames = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort()

for (const pkgName of packageNames) {
	const baseEntries = baseline[pkgName] ?? {}
	const currEntries = current[pkgName] ?? {}
	const subpaths = [...new Set([...Object.keys(baseEntries), ...Object.keys(currEntries)])].sort()

	if (subpaths.length === 0) {
		console.log(`${pkgName}: no guardable entry point`)
		continue
	}

	for (const subpath of subpaths) {
		const base = baseEntries[subpath]
		const curr = currEntries[subpath]

		if (base && !curr) {
			console.error(`\n✗ ENTRY POINT GONE — ${pkgName} ${subpath} was guarded and is no longer exported.`)
			failed = true
			continue
		}
		if (!base && curr) {
			console.error(
				`\n✗ ENTRY POINT UNRECORDED — ${pkgName} ${subpath} exports ` +
					`${curr.runtime.length} runtime / ${curr.declared.length} declared names that no baseline covers.`,
			)
			failed = true
			continue
		}

		for (const label of ['runtime', 'declared', 'deprecated']) {
			const before = base[label] ?? []
			const after = curr[label] ?? []
			const missing = before.filter((name) => !after.includes(name))
			const added = after.filter((name) => !before.includes(name))

			if (missing.length > 0) {
				console.error(
					`\n✗ PUBLIC-SURFACE REGRESSION — ${pkgName} ${subpath} (${label}) — ${missing.length} names dropped:`,
				)
				for (const name of missing) console.error(`  - ${name}`)
				failed = true
			}
			if (added.length > 0) {
				console.error(
					`\n✗ PUBLIC-SURFACE WIDENED — ${pkgName} ${subpath} (${label}) — ${added.length} names added:`,
				)
				for (const name of added) console.error(`  - ${name}`)
				failed = true
			}
		}
	}
}

if (failed) {
	console.error(
		'\n  Regenerate the baseline in this commit:\n' +
			'    pnpm -r build\n' +
			'    node .github/scripts/verify-public-surface.mjs --write\n' +
			'\n  Widening fails rather than warns because a name outside the baseline\n' +
			'  is invisible to the removal check: it compares `baseline - current`, so\n' +
			'  anything added and never recorded can be deleted later and still read\n' +
			'  as "intact".',
	)
	process.exit(1)
}

const t = totals()
console.log(
	`\n✓ public surface intact — ${Object.keys(current).length} packages, ${t.entries} entry points, ` +
		`${t.runtime} runtime, ${t.declared} declared, ${t.deprecated} deprecated`,
)
