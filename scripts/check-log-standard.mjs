#!/usr/bin/env node
/**
 * Log-standard gate — the enforcement seed for the adoption rule in
 * docs/conventions/one-record-one-shape.md:
 *
 *   "Every diagnostic is emitted through a logger the caller was given, with
 *   a constant body and namespaced attributes. Nothing under `packages/*\/src`
 *   reads a logger from module scope or writes to a stream directly."
 *
 * This is the SEED (LOG-02), not the finished gate. The full rule set has
 * nine checks; five of them need `ts.createProgram` + the type checker to
 * resolve a call's RECEIVER — is this really a `Logger`, or an unrelated
 * object that happens to have an `.info()` method — and those wait for
 * LOG-14. The four implemented here are decidable from syntax alone, because
 * what they match is not a receiver type but a fixed name: `console` and
 * `process` are globals, `getRootLogger` is a specific imported function, and
 * `component` is a literal property key. A syntactic walk (`ts.createSourceFile`
 * only — no program, no type checker, no build output required) finds all
 * four without false positives on the tree as it stands today.
 *
 * That precision is real but bounded, and the bound is worth stating rather
 * than discovering later: `const c = console; c.log(...)`, a `Logger` reached
 * through a wrapper class, or a `component` key on some unrelated object all
 * walk through this gate unnoticed. Closing that is what the type-aware rules
 * in LOG-14 are for — this seed does not claim to be them.
 *
 * A note on overlap: `packages/*\/biome.json` already sets
 * `suspicious.noConsole: "warn"`, but no package's lint script raises
 * warnings to errors, so `pnpm lint` cannot fail a build on a bare
 * `console.log` today. This gate is not duplicate coverage — it is the first
 * check on this tree that can actually fail CI over a console call.
 *
 * ## Two enforcement shapes, both exact-equality
 *
 * - **Ratchets** (`getRootLoggerCount`, `unnamespacedBindingCount`) — one
 *   number each in scripts/log-standard.json, compared with `!==`, never
 *   `>`. A ceiling lets the true count drift upward as long as it stays
 *   under the line, and the gate would report nothing wrong while measuring
 *   nothing real. Exact equality forces every change — up OR down — to touch
 *   the JSON file, where a reviewer sees it move.
 * - **Allowlists** (`consoleAllowlist`, `streamWriteAllowlist`) — every
 *   permitted site enumerated by file, symbol (`console.error`,
 *   `process.stderr.write`, …) and a human-authored reason, carrying an
 *   exact permitted COUNT per (file, symbol) pair. Per-file exemption was
 *   considered and rejected: it would let a fifth, unreviewed call into a
 *   file that already has one call excused, for free. Counting per symbol
 *   means it cannot — a file already at its allowed count that gains one
 *   more call fails exactly like a file with none allowed at all.
 *
 * Both shapes fail in both directions. A count that goes DOWN without the
 * file being edited is exactly as wrong as one that goes up: either way the
 * file has stopped describing the tree, which is the one thing a ratchet
 * exists to prevent going unnoticed.
 *
 * ## No escape hatch
 *
 * No env var, no CLI flag that skips a check. The one flag this script reads
 * is `--write`, and it does not weaken anything: it recomputes and overwrites
 * ONLY the two ratchet numbers, from the same scan the check itself runs.
 * The allowlists are never touched by `--write` — a new or removed
 * console/stream-write site needs a human-authored reason, and a script
 * cannot honestly generate one. Per the design: "A fifth call requires
 * editing that file — a diff a reviewer sees."
 *
 * ## Scope
 *
 * Rules run over `packages/*\/src/**\/*.ts{,x}`, excluding `__tests__`,
 * `__fixtures__` directories and `*.test.ts(x)` files. Read literally rather
 * than as a glob in prose: `packages/*\/src` reaches exactly one directory
 * below `packages/`, so `packages/providers/<name>/src` — nested one level
 * deeper — is NOT scanned. Measured empty of console/stream/logger hits at
 * seed time (2026-08-15); a provider package that starts writing to a stream
 * directly will not be caught here until this glob is revisited.
 *
 * `getRootLoggerCount` and `unnamespacedBindingCount` narrow further, to
 * `packages/sdk/src/` only — the `Logger`/`child()` API those two rules
 * police is an SDK type, and the numbers recorded in log-standard.json are
 * SDK-only counts. `consoleAllowlist` and `streamWriteAllowlist` are not
 * narrowed; they already have real, permitted sites outside the SDK
 * (`packages/telemetry`, `packages/cli`).
 *
 * Convention: "enumerate what counts, don't infer" — the same discipline as
 * `.github/scripts/check-sdk-test-presence.mjs`, in temperament rather than
 * mechanism: that script reads a directory listing, this one parses syntax.
 */

import ts from 'typescript'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, sep } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const configPath = join(__dirname, 'log-standard.json')

const SKIP_DIRS = new Set(['__tests__', '__fixtures__', 'node_modules', 'dist'])

function isTestFile(name) {
	return name.endsWith('.test.ts') || name.endsWith('.test.tsx')
}

function walkDir(dir, out) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry)
		let st
		try {
			st = statSync(full)
		} catch {
			// A symlink or a file removed between readdir and stat — either way
			// there is nothing here to scan, not a reason to abort the walk.
			continue
		}
		if (st.isDirectory()) {
			if (SKIP_DIRS.has(entry)) continue
			walkDir(full, out)
		} else if (st.isFile() && (entry.endsWith('.ts') || entry.endsWith('.tsx')) && !isTestFile(entry)) {
			out.push(full)
		}
	}
	return out
}

/**
 * `packages/*` in prose is not `packages/*` in code: this reads exactly one
 * directory below `packages/`, so `packages/providers/<name>/src` (nested one
 * level deeper) is out of scope — see the file header.
 */
function collectSourceFiles() {
	const packagesDir = join(repoRoot, 'packages')
	const fullPaths = []
	for (const name of readdirSync(packagesDir)) {
		const srcDir = join(packagesDir, name, 'src')
		let st
		try {
			st = statSync(srcDir)
		} catch {
			continue
		}
		if (st.isDirectory()) walkDir(srcDir, fullPaths)
	}
	return fullPaths.map((full) => ({ full, rel: relative(repoRoot, full).split(sep).join('/') }))
}

function loadFileEntries() {
	return collectSourceFiles().map(({ full, rel }) => ({ rel, text: readFileSync(full, 'utf8') }))
}

// ---------------------------------------------------------------------------
// Pure AST layer. Nothing below this line touches the filesystem — every
// function takes already-loaded { rel, text } entries, which is what lets
// the test suite hand it synthetic and fixture text directly instead of
// writing files into packages/*/src to exercise it.
// ---------------------------------------------------------------------------

/** Parses `text` as `fileName` (syntax only — no program, no type checker)
 * and calls `visitor` on every node. The one parse primitive every rule
 * below is built from. */
function forEachNode(text, fileName, visitor) {
	const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
	const walk = (node) => {
		visitor(node)
		ts.forEachChild(node, walk)
	}
	walk(source)
}

function consoleSymbol(node) {
	if (
		ts.isCallExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		ts.isIdentifier(node.expression.expression) &&
		node.expression.expression.text === 'console'
	) {
		return `console.${node.expression.name.text}`
	}
	return undefined
}

function streamWriteSymbol(node) {
	if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined
	const outer = node.expression
	if (outer.name.text !== 'write' || !ts.isPropertyAccessExpression(outer.expression)) return undefined
	const inner = outer.expression
	if (
		ts.isIdentifier(inner.expression) &&
		inner.expression.text === 'process' &&
		(inner.name.text === 'stdout' || inner.name.text === 'stderr')
	) {
		return `process.${inner.name.text}.write`
	}
	return undefined
}

function isGetRootLoggerCall(node) {
	return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'getRootLogger'
}

// Both plain (`{ component: x }`) and shorthand (`{ component }`) bindings
// count — the shorthand form does not appear on the tree today, but a rule
// that only caught the spelled-out form would be evaded by the first person
// who destructured a variable named `component` into an object literal.
function isComponentBinding(node) {
	if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'component') return true
	if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'component') return true
	return false
}

function countSitesBySymbol(fileEntries, symbolOf) {
	const counts = new Map()
	for (const { rel, text } of fileEntries) {
		forEachNode(text, rel, (node) => {
			const symbol = symbolOf(node)
			if (symbol === undefined) return
			const key = `${rel} ${symbol}`
			counts.set(key, (counts.get(key) ?? 0) + 1)
		})
	}
	return counts
}

function countSdkOnlyOccurrences(fileEntries, predicate) {
	let count = 0
	for (const { rel, text } of fileEntries) {
		if (!rel.startsWith('packages/sdk/src/')) continue
		forEachNode(text, rel, (node) => {
			if (predicate(node)) count++
		})
	}
	return count
}

/**
 * Shared comparator for both allowlists. Exact per-(file,symbol) count,
 * both directions: a site with no matching entry (or more occurrences than
 * its entry allows) fails, and so does an entry with occurrences left over
 * at zero — the same "actual !== stored, not actual > stored" discipline
 * the two ratchets use, applied per row instead of to one grand total.
 */
function compareAllowlist(actualCounts, allowlist, ruleName) {
	const allowed = new Map(allowlist.map((e) => [`${e.file} ${e.symbol}`, e]))
	const seen = new Set()
	const violations = []

	for (const [key, count] of actualCounts) {
		seen.add(key)
		const [file, symbol] = key.split(' ')
		const entry = allowed.get(key)
		const allowedCount = entry?.count ?? 0
		if (count === allowedCount) continue
		violations.push({
			rule: ruleName,
			file,
			message: entry
				? `${symbol} appears ${count} time(s) in ${file}; scripts/log-standard.json allows ${allowedCount} ` +
					`("${entry.reason}"). Update the allowlist count in the same commit that changes the code, in ` +
					'either direction.'
				: `${symbol} appears ${count} time(s) in ${file}, which is not in scripts/log-standard.json's ` +
					'allowlist. A new site needs a listed file, symbol and reason before it can land — or it needs ' +
					'to go through a Logger instead.',
		})
	}

	for (const [key, entry] of allowed) {
		if (entry.count > 0 && !seen.has(key)) {
			violations.push({
				rule: ruleName,
				file: entry.file,
				message: `scripts/log-standard.json allows ${entry.count} ${entry.symbol} in ${entry.file} ` +
					`("${entry.reason}"), but none remain. Lower the count so the file describes the tree.`,
			})
		}
	}

	return violations
}

// ---------------------------------------------------------------------------
// The four rules. Each body is bracketed by MUTATION-MARKER comments the
// mutation-proof test in scripts/__tests__/check-log-standard.test.ts uses
// to stub the rule to `return []` in a throwaway copy of this file and
// re-run its fixture — proving the rule, and not something adjacent to it,
// is what catches that fixture. Keep each body fully between its markers:
// the stub replaces everything from START through END with `return []`, and
// anything left outside that range survives the "deletion" un-mutated.
// ---------------------------------------------------------------------------

export function checkConsoleAllowlist(fileEntries, config) {
	// MUTATION-MARKER:console:START
	const actual = countSitesBySymbol(fileEntries, consoleSymbol)
	return compareAllowlist(actual, config.consoleAllowlist, 'console-allowlist')
	// MUTATION-MARKER:console:END
}

export function checkStreamWriteAllowlist(fileEntries, config) {
	// MUTATION-MARKER:streamWrite:START
	const actual = countSitesBySymbol(fileEntries, streamWriteSymbol)
	return compareAllowlist(actual, config.streamWriteAllowlist, 'stream-write-allowlist')
	// MUTATION-MARKER:streamWrite:END
}

export function checkGetRootLoggerRatchet(fileEntries, config) {
	// MUTATION-MARKER:getRootLogger:START
	const actual = countSdkOnlyOccurrences(fileEntries, isGetRootLoggerCall)
	if (actual === config.getRootLoggerCount) return []
	return [
		{
			rule: 'getRootLoggerCount',
			file: null,
			message: `getRootLogger() is called ${actual} time(s) in packages/sdk/src (excluding tests); ` +
				`scripts/log-standard.json#getRootLoggerCount records ${config.getRootLoggerCount}. The ratchet ` +
				'fails on any mismatch, not only an increase — update the file in the commit that changes the count.',
		},
	]
	// MUTATION-MARKER:getRootLogger:END
}

export function checkUnnamespacedBindingRatchet(fileEntries, config) {
	// MUTATION-MARKER:unnamespacedBinding:START
	const actual = countSdkOnlyOccurrences(fileEntries, isComponentBinding)
	if (actual === config.unnamespacedBindingCount) return []
	return [
		{
			rule: 'unnamespacedBindingCount',
			file: null,
			message: `component: bindings total ${actual} in packages/sdk/src (excluding tests); ` +
				`scripts/log-standard.json#unnamespacedBindingCount records ${config.unnamespacedBindingCount}. ` +
				'The ratchet fails on any mismatch, not only an increase.',
		},
	]
	// MUTATION-MARKER:unnamespacedBinding:END
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

function formatViolation(v) {
	return `  [${v.rule}]${v.file ? ` ${v.file}` : ''} — ${v.message}`
}

function main() {
	const config = JSON.parse(readFileSync(configPath, 'utf8'))
	const fileEntries = loadFileEntries()

	if (process.argv.includes('--write')) {
		const nextGetRootLoggerCount = countSdkOnlyOccurrences(fileEntries, isGetRootLoggerCall)
		const nextUnnamespacedBindingCount = countSdkOnlyOccurrences(fileEntries, isComponentBinding)
		const next = {
			...config,
			getRootLoggerCount: nextGetRootLoggerCount,
			unnamespacedBindingCount: nextUnnamespacedBindingCount,
		}
		writeFileSync(configPath, `${JSON.stringify(next, null, '\t')}\n`)
		console.log(
			`scripts/log-standard.json written: getRootLoggerCount ${config.getRootLoggerCount} -> ` +
				`${nextGetRootLoggerCount}, unnamespacedBindingCount ${config.unnamespacedBindingCount} -> ` +
				`${nextUnnamespacedBindingCount}`,
		)
		console.log(
			'The console.* and stream-write allowlists are not touched by --write: a new or removed site needs a ' +
				'human-authored reason, not a guess. Edit scripts/log-standard.json directly.',
		)
		process.exit(0)
	}

	const violations = [
		...checkConsoleAllowlist(fileEntries, config),
		...checkStreamWriteAllowlist(fileEntries, config),
		...checkGetRootLoggerRatchet(fileEntries, config),
		...checkUnnamespacedBindingRatchet(fileEntries, config),
	]

	if (violations.length === 0) {
		console.log(`✓ log standard gate passed (${fileEntries.length} files scanned)`)
		process.exit(0)
	}

	console.error(`\n✗ LOG STANDARD VIOLATIONS — ${violations.length}:`)
	for (const v of violations) console.error(formatViolation(v))
	process.exit(1)
}

// Runs the CLI only when this file is invoked directly (`node
// scripts/check-log-standard.mjs`), not when it is imported. The test suite
// imports the four `check*` exports above against synthetic and fixture
// text; a bare import must not shell out to `process.exit`.
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) main()
