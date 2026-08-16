#!/usr/bin/env node
/**
 * Log-standard gate — the enforcement seed for the adoption rule in
 * docs/conventions/one-record-one-shape.md:
 *
 *   "Every diagnostic is emitted through a logger the caller was given, with
 *   a constant body and namespaced attributes. Nothing under `packages/*\/src`
 *   reads a logger from module scope or writes to a stream directly."
 *
 * This started as a SEED (LOG-02): four rules decidable from syntax alone —
 * `console`/`process` are globals, `getRootLogger` is a specific imported
 * function, `component` is a literal property key, none of which need a
 * receiver's TYPE. LOG-13 added the two rules that DO: rule 3 (constant
 * message body) and rule 4 (namespaced attribute keys) both turn on whether
 * a call's RECEIVER really is a `Logger` — an unrelated object with an
 * `.info()` method must NOT be flagged — and there is no syntactic
 * substitute for asking the compiler that. Six of the full rule set's nine
 * checks are enforced as of LOG-13; the remaining three were named in the
 * original design as also needing the type checker and are left for a
 * later task — this file is closer to the finished gate than it was, not
 * at it.
 *
 * The four syntax-only rules stay exactly as precise, and exactly as
 * bounded, as before: `const c = console; c.log(...)`, a `Logger` reached
 * through a wrapper class, or a `component` key on some unrelated object
 * still walk through THOSE four rules unnoticed by name alone. Rules 3 and
 * 4, in the "Type-aware layer" section below, close that same gap for
 * message bodies and attribute keys specifically, by resolving the
 * receiver's TYPE instead of its spelling.
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
 * Rules run over every `src/` under `packages/`, excluding `__tests__`,
 * `__fixtures__` directories and `*.test.ts(x)` files.
 *
 * Both nesting depths, which was not always true. This originally read
 * exactly one directory below `packages/`, leaving
 * `packages/providers/<name>/src` — seven driver packages — outside the gate,
 * with the header recording that they were "measured empty at seed time
 * (2026-08-15)" and would stay uncaught "until this glob is revisited". A
 * dated measurement is not a check, and that sentence carried its own expiry.
 * Revisited on 2026-08-16: still empty, so the widening added no violations
 * and cost nothing — which is the only condition under which widening a gate
 * is free. See `packageSourceDirs`, which bounds the descent at two levels
 * deliberately.
 *
 * `getRootLoggerCount` and `unnamespacedBindingCount` narrow further, to
 * `packages/sdk/src/` only — the `Logger`/`child()` API those two rules
 * police is an SDK type, and the numbers recorded in log-standard.json are
 * SDK-only counts. `consoleAllowlist` and `streamWriteAllowlist` are not
 * narrowed; they already have real, permitted sites outside the SDK
 * (`packages/telemetry`, `packages/cli`).
 *
 * `constantBodyViolationCount` and `namespacedAttributeKeyViolationCount`
 * (rules 3 and 4) are NOT narrowed either, for the same reason as the two
 * allowlists: `Logger` is used well outside the SDK (`packages/cli`'s own
 * `this.log`/`getRootLogger()` call sites), so narrowing to
 * `packages/sdk/src/` would silently stop watching every one of them. Both
 * ratchets are non-zero at the time LOG-13 lands — 87 and 802 respectively —
 * which is the honest count of a real, pre-existing gap this task's own
 * risk section anticipated, not a defect in the rule: driving either to
 * zero is its own future task, the same shape LOG-09 was for
 * `unnamespacedBindingCount`.
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
 * Every `src/` under `packages/`, at either nesting depth.
 *
 * This used to read exactly one directory below `packages/`, which put
 * `packages/providers/<name>/src` — nested one level deeper — outside the
 * gate entirely. That was recorded honestly rather than hidden: the header
 * said the provider tree was "measured empty of console/stream/logger hits at
 * seed time (2026-08-15)" and would not be caught "until this glob is
 * revisited". Which is a dated measurement standing in for a check, and the
 * expiry was written into the sentence.
 *
 * Revisited, and still empty — so widening cost nothing at the time it was
 * free, which is the only time widening a gate is ever free. A driver package
 * is exactly where a stray `console.error` on a failed request is most
 * tempting, and there are seven of them.
 *
 * Depth is bounded at two on purpose rather than walking `packages/`
 * arbitrarily deep: `packages/<pkg>/src` and `packages/<group>/<pkg>/src` are
 * the two shapes this repo has, and an unbounded walk would also descend into
 * a nested `node_modules` or a fixture package's own `src`.
 */
function collectSourceFiles() {
	const packagesDir = join(repoRoot, 'packages')
	const fullPaths = []
	for (const dir of packageSourceDirs(packagesDir)) walkDir(dir, fullPaths)
	return fullPaths.map((full) => ({ full, rel: relative(repoRoot, full).split(sep).join('/') }))
}

export function packageSourceDirs(packagesDir) {
	const found = []
	for (const name of readdirSync(packagesDir)) {
		if (name === 'node_modules') continue
		const child = join(packagesDir, name)
		if (!isDirectory(child)) continue
		if (isDirectory(join(child, 'src'))) {
			found.push(join(child, 'src'))
			continue
		}
		// No `src/` of its own — a grouping directory like `providers/`, so
		// look one level further and no further.
		for (const nested of readdirSync(child)) {
			if (nested === 'node_modules') continue
			const nestedSrc = join(child, nested, 'src')
			if (isDirectory(nestedSrc)) found.push(nestedSrc)
		}
	}
	return found
}

function isDirectory(path) {
	try {
		return statSync(path).isDirectory()
	} catch {
		return false
	}
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
// Type-aware layer (LOG-13, closing two of the five checks the file header's
// SEED note names — "constant log bodies" and "namespaced attribute keys").
// Everything above this line is pure AST: no ts.Program, no type checker,
// callable on synthetic in-memory text with no file on disk, which is what
// let the first four rules' tests hand fixture TEXT directly. Rules 3 and 4
// cannot work that way: "is this receiver really a Logger" and "is this
// attribute bag really namespaced" are both questions about a DECLARED
// TYPE, and there is no syntactic substitute for asking the compiler (see
// .github/scripts/verify-public-surface.mjs, which already drives
// ts.createProgram from a script in this repo — the same technique, read
// from there rather than invented fresh). Every fixture these two rules run
// against is consequently a REAL file on disk under
// scripts/__fixtures__/log-standard/, importing the ACTUAL `Logger` and
// `LogAttributes` types from packages/sdk/src — never a hand-rolled
// stand-in interface, which is exactly the shallow-fixture failure
// fixture-must-match-production names.
// ---------------------------------------------------------------------------

/**
 * Compiler options for the gate's OWN Program — deliberately not the
 * workspace's strict tsconfig.json. This Program exists to resolve TYPES
 * (is this receiver assignable to Logger, is this bag assignable to
 * LogAttributes), never to raise diagnostics; strict/noUnusedLocals/etc.
 * would spend time checking things nothing here reads. Verified directly:
 * flipping `strict: true` on this exact PROGRAM_OPTIONS object, over the
 * same file set, changes namespacedAttributeKeyViolationCount from 805 to
 * 766 pre-fix (constantBodyViolationCount is unaffected) — the ratchet
 * numbers below describe THIS Program's answer, not a claim about what the
 * workspace's own strict tsconfig would say if asked the same question.
 */
const PROGRAM_OPTIONS = {
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.NodeNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
	lib: ['lib.es2022.d.ts'],
	types: ['node'],
	esModuleInterop: true,
	skipLibCheck: true,
	resolveJsonModule: true,
	jsx: ts.JsxEmit.ReactJSX,
	jsxImportSource: 'react',
	noEmit: true,
}

/**
 * One ts.Program over every absolute path in `fullPaths`. Measured at ~0.9s
 * over the whole workspace (602 files across packages/*\/src) on the tree at
 * seed time (2026-08-16) — cheap next to the steps around it in CI, because
 * NodeNext moduleResolution walks straight through each OTHER package's
 * node_modules symlink to its BUILT dist/*.d.ts, not back through this
 * gate's own source list. That means the "Log standard gate" CI step (see
 * .github/workflows/ci.yml) depends on the "Build" step ahead of it the
 * same way .github/scripts/verify-public-surface.mjs already does — and
 * locally, a worktree that has not run `pnpm -r build` resolves every
 * CROSS-package Logger/LogAttributes reference to an error type, which
 * silently reads as "not a Logger" rather than failing loudly. See the
 * worktrees section of AGENTS.md for why an unbuilt worktree fails gates
 * that read build output; this is now one of them.
 */
function buildProgram(fullPaths) {
	return ts.createProgram(fullPaths, PROGRAM_OPTIONS)
}

/** The declared TYPE of a named export, resolved through the checker rather
 * than hand-written — so if `Logger` or `LogAttributes` ever changes shape,
 * both rules below move with it instead of drifting from a copy. */
function resolveExportedType(program, checker, fileSuffix, exportName) {
	const source = program.getSourceFiles().find((f) => f.fileName.endsWith(fileSuffix))
	if (!source) {
		throw new Error(
			`log-standard type-aware setup: ${fileSuffix} is not part of the built Program — is collectSourceFiles() missing it, or did the file move?`,
		)
	}
	const moduleSymbol = checker.getSymbolAtLocation(source)
	const exported = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === exportName)
	if (!exported) throw new Error(`log-standard type-aware setup: ${exportName} is not exported from ${fileSuffix}`)
	return checker.getDeclaredTypeOfSymbol(exported)
}

const LOG_METHOD_NAMES = new Set(['debug', 'info', 'warn', 'error'])
const ATTRIBUTE_KEY_PATTERN = /^(namzu|gen_ai|service|exception)\./
const MAX_ATTRIBUTE_BAG_HOPS = 5

/**
 * Resolves a COMPUTED property key to literal text when — and only when —
 * it provably folds to one: a string literal directly, or (through at most
 * one import alias) a reference to a top-level `const x = '...'`. Anything
 * else — a parameter, a `let`, a function call, a ternary — is NOT
 * resolvable, and the caller treats "not resolvable" as a violation: deny
 * what cannot be verified (`refuse-do-not-degrade`) rather than silently
 * accept an unprovable key. `EVENT_NAME_ATTRIBUTE`/`SCOPE_ATTRIBUTE` are the
 * real, present-tense case this exists for — both are `const EVENT_NAME_
 * ATTRIBUTE = 'namzu.event.name'` in utils/log/types.ts, imported wherever
 * a computed `[EVENT_NAME_ATTRIBUTE]: ...` key appears, and both fold to a
 * literal that already matches the namespace pattern. Without the alias
 * hop, every one of those real call sites reads as unresolvable — measured
 * directly while building this rule, before the hop was added.
 *
 * A PROPERTY ACCESS folds too — `NAMZU.RUN_ID` against the `as const`
 * constants table — and that branch was missing, which made this rule
 * penalise the very table it was written alongside. `[NAMZU.RUN_ID]` read
 * as unresolvable while the string literal `'namzu.run.id'` passed, so the
 * gate rewarded the hand-typed spelling over the shared constant: exactly
 * backwards.
 *
 * **Adding it moves the baseline by zero, and that is worth stating.** The
 * tree has 45 `[NAMZU.X]` computed keys, but this rule only inspects the
 * second argument of a Logger call, and nearly all 45 are span attributes
 * it never looks at. So the gap was real and had simply never been reached
 * — measured by adding one such key to a Logger call, which moved the count
 * 797 → 798 before this branch and left it at 797 after. A fix whose
 * baseline does not move is easy to mistake for a fix that does nothing;
 * the fixture's 'k' and 'l' cases are what hold it.
 *
 * The fold goes through the TYPE rather than the declaration, and that is
 * what keeps it conservative. `NAMZU.RUN_ID` has type `"namzu.run.id"` only
 * because the table is `as const`; drop the `as const` and the type widens
 * to `string`, which does not fold — which is right, because a mutable
 * property is not a provable key. Nothing is accepted here that the type
 * system cannot already name.
 */
function resolveLiteralKeyText(expr, checker) {
	if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text
	if (ts.isPropertyAccessExpression(expr)) {
		const type = checker.getTypeAtLocation(expr)
		return type.isStringLiteral() ? type.value : undefined
	}
	if (!ts.isIdentifier(expr)) return undefined
	let symbol = checker.getSymbolAtLocation(expr)
	if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
	const decl = symbol?.valueDeclaration
	if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer || !ts.isStringLiteral(decl.initializer)) return undefined
	const declList = decl.parent
	if (!ts.isVariableDeclarationList(declList) || !(declList.flags & ts.NodeFlags.Const)) return undefined
	return decl.initializer.text
}

/**
 * Finds the Logger-typed receiver of a call to debug/info/warn/error and
 * returns the method name, or undefined if this is not one of those four
 * calls OR its receiver does not resolve to Logger. Structural, via
 * `checker.isTypeAssignableTo` against the REAL `Logger` interface declared
 * in packages/sdk/src/utils/logger.ts — never a name match. `Logger` has
 * never been a nominal type here (that file's own header: it is frozen,
 * INPUT position on the public surface), so anything shaped like one
 * already behaves like one at every call site; anything missing a member
 * or with an incompatible signature — `Formatter` in
 * packages/cli/src/output/*, which also has `.info()`/`.error()` — is NOT
 * assignable and is correctly left alone. Verified against the real
 * Formatter/Console call sites on this tree while building this rule: all
 * read as non-Logger, none misdetected.
 *
 * Two receiver shapes a name-only walk cannot tell apart from an ordinary
 * one:
 *   - `x.info(...)` / `this.log.info(...)` — ordinary and ALIASED property
 *     access (`const l = logger; l.info(...)`); the object's TYPE is what
 *     is checked, not its spelling. `this.log?.info(...)` (optional
 *     chaining on a `log?: Logger` field) resolves through the SAME path —
 *     `checker.getTypeAtLocation` on the object of an optional-chain
 *     access already returns the non-nullable narrowed type, confirmed
 *     against packages/cli/src/doctor/registry.ts's `this.log?.warn(...)`
 *     sites.
 *   - `info(...)` after `const { info } = someLogger` — DESTRUCTURED; no
 *     receiver exists at the call site at all, so this walks back to the
 *     ORIGINATING object's initializer and checks that instead.
 */
function loggerCallMethodName(node, loggerType, checker) {
	if (ts.isPropertyAccessExpression(node.expression) && LOG_METHOD_NAMES.has(node.expression.name.text)) {
		const receiverType = checker.getTypeAtLocation(node.expression.expression)
		return checker.isTypeAssignableTo(receiverType, loggerType) ? node.expression.name.text : undefined
	}
	if (ts.isIdentifier(node.expression) && LOG_METHOD_NAMES.has(node.expression.text)) {
		const symbol = checker.getSymbolAtLocation(node.expression)
		const decl = symbol?.valueDeclaration
		if (!decl || !ts.isBindingElement(decl) || !ts.isObjectBindingPattern(decl.parent)) return undefined
		const varDecl = decl.parent.parent
		if (!ts.isVariableDeclaration(varDecl) || !varDecl.initializer) return undefined
		const originType = checker.getTypeAtLocation(varDecl.initializer)
		return checker.isTypeAssignableTo(originType, loggerType) ? node.expression.text : undefined
	}
	return undefined
}

/**
 * Walks an attribute bag — the whole 2nd argument to a confirmed Logger
 * call, a spread's expression, or one branch of a ternary — and returns
 * violation records (empty = compliant). Two modes, chosen by shape:
 *
 *   - An OBJECT LITERAL is walked property by property: each key is
 *     checked against ATTRIBUTE_KEY_PATTERN directly (or, for a computed
 *     key, via resolveLiteralKeyText — unresolvable is a violation, not a
 *     skip, per refuse-do-not-degrade). A nested spread recurses into this
 *     same function.
 *   - Anything else — an identifier, a call, a property access — cannot be
 *     walked property by property, so it is trusted ONLY when its type is
 *     STRUCTURALLY EQUAL to LogAttributes: assignable BOTH ways, not just
 *     into it. One direction alone is not enough — `Record<AttributeKey,
 *     AttributeValue>` tolerates an object with an unlisted property like
 *     `{ errorCode: string }` on the permissive (into) side, because a
 *     mapped type over a template-literal key pattern has no fixed set of
 *     REQUIRED properties for a normal structural check to enforce; only
 *     the reverse direction — is LogAttributes itself assignable back to
 *     `{ errorCode: string }` — fails, because the generic pattern type has
 *     no concrete `errorCode` member. Measured directly while building this
 *     rule: `{ errorCode: string }` is one-way assignable to LogAttributes,
 *     and a single-direction check would have passed it silently.
 *
 *     Symbol identity was tried and rejected for this: packages/sdk/src
 *     resolves `LogAttributes` from ITS OWN source file, but every OTHER
 *     package resolves the same type through `@namzu/sdk`'s BUILT
 *     dist/index.d.ts — a separate parse with a separate symbol for an
 *     identical shape. `sym === theOneCanonicalSymbol` floors every
 *     downstream package; bidirectional structural equality does not care
 *     which file declared it.
 *
 *   Before falling to the type check, an UNANNOTATED local (`const x =
 *   {...}`, no `: LogAttributes`) is chased back to its initializer and
 *   walked there instead — bounded by MAX_ATTRIBUTE_BAG_HOPS — so a
 *   perfectly namespaced bag someone forgot to annotate is not flagged just
 *   for lacking an annotation the type check alone would require.
 */
function checkAttributeBag(expr, checker, logAttributesType, hops = 0) {
	if (ts.isObjectLiteralExpression(expr)) {
		const violations = []
		for (const prop of expr.properties) {
			if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
				let keyText
				if (ts.isShorthandPropertyAssignment(prop)) {
					keyText = prop.name.text
				} else if (ts.isComputedPropertyName(prop.name)) {
					keyText = resolveLiteralKeyText(prop.name.expression, checker)
					if (keyText === undefined) {
						violations.push({ detail: 'a computed attribute key that does not fold to a literal string' })
						continue
					}
				} else if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) {
					keyText = prop.name.text
				} else {
					keyText = prop.name.getText()
				}
				if (!ATTRIBUTE_KEY_PATTERN.test(keyText)) {
					violations.push({ detail: `attribute key "${keyText}" does not start with namzu./gen_ai./service./exception.` })
				}
			} else if (ts.isSpreadAssignment(prop)) {
				violations.push(...checkAttributeBag(prop.expression, checker, logAttributesType, hops))
			}
			// A method/getter/setter inside a plain data-bag literal is exotic
			// enough that it does not appear anywhere on this tree — left
			// unhandled deliberately rather than guessed at.
		}
		return violations
	}
	if (ts.isParenthesizedExpression(expr)) return checkAttributeBag(expr.expression, checker, logAttributesType, hops)
	if (ts.isConditionalExpression(expr)) {
		return [
			...checkAttributeBag(expr.whenTrue, checker, logAttributesType, hops),
			...checkAttributeBag(expr.whenFalse, checker, logAttributesType, hops),
		]
	}
	if (hops < MAX_ATTRIBUTE_BAG_HOPS && ts.isIdentifier(expr)) {
		let symbol = checker.getSymbolAtLocation(expr)
		if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
		const decl = symbol?.valueDeclaration
		if (decl && ts.isVariableDeclaration(decl) && !decl.type && decl.initializer) {
			return checkAttributeBag(decl.initializer, checker, logAttributesType, hops + 1)
		}
	}
	const type = checker.getTypeAtLocation(expr)
	const assignableIn = checker.isTypeAssignableTo(type, logAttributesType)
	const assignableOut = checker.isTypeAssignableTo(logAttributesType, type)
	if (assignableIn && assignableOut) return []
	return [{ detail: `attribute bag is not provably LogAttributes (resolved type: ${checker.typeToString(type)})` }]
}

/** Raw count behind checkConstantBody — factored out so `--write` can
 * recompute it without going through the ratchet-compare wrapper, the same
 * split `countSdkOnlyOccurrences` already has for the two syntax-only
 * ratchets above. */
function countConstantBodyViolations(program, fullPaths) {
	const checker = program.getTypeChecker()
	const loggerType = resolveExportedType(program, checker, 'packages/sdk/src/utils/logger.ts', 'Logger')
	let count = 0
	for (const full of fullPaths) {
		const source = program.getSourceFile(full)
		if (!source) throw new Error(`countConstantBodyViolations: ${full} is not part of the Program`)
		const walk = (node) => {
			if (ts.isCallExpression(node) && loggerCallMethodName(node, loggerType, checker)) {
				const first = node.arguments[0]
				if (first) {
					const isTemplateWithHole = ts.isTemplateExpression(first)
					const isPlusConcat = ts.isBinaryExpression(first) && first.operatorToken.kind === ts.SyntaxKind.PlusToken
					if (isTemplateWithHole || isPlusConcat) count++
				}
			}
			ts.forEachChild(node, walk)
		}
		walk(source)
	}
	return count
}

/**
 * The individual violation details behind checkNamespacedAttributeKeys.
 *
 * The count alone cannot distinguish "the `as const` fold regressed and a
 * new case was added" from "nothing changed" — both leave the total where
 * it was. Exported so a test can assert WHICH keys were counted, which is
 * the only way the fold and its refusal can be pinned separately.
 */
export function namespacedAttributeKeyDetails(program, fullPaths) {
	const checker = program.getTypeChecker()
	const loggerType = resolveExportedType(program, checker, 'packages/sdk/src/utils/logger.ts', 'Logger')
	const logAttributesType = resolveExportedType(program, checker, 'packages/sdk/src/utils/log/attributes.ts', 'LogAttributes')
	const details = []
	for (const full of fullPaths) {
		const source = program.getSourceFile(full)
		if (!source) throw new Error(`namespacedAttributeKeyDetails: ${full} is not part of the Program`)
		const walk = (node) => {
			if (ts.isCallExpression(node) && loggerCallMethodName(node, loggerType, checker)) {
				const second = node.arguments[1]
				if (second) {
					for (const violation of checkAttributeBag(second, checker, logAttributesType)) {
						details.push(violation.detail)
					}
				}
			}
			ts.forEachChild(node, walk)
		}
		walk(source)
	}
	return details
}

/** Raw count behind checkNamespacedAttributeKeys — see
 * countConstantBodyViolations above for why this is split out. */
function countNamespacedAttributeKeyViolations(program, fullPaths) {
	return namespacedAttributeKeyDetails(program, fullPaths).length
}

export function checkConstantBody(program, fullPaths, config) {
	// MUTATION-MARKER:constantBody:START
	const actual = countConstantBodyViolations(program, fullPaths)
	if (actual === config.constantBodyViolationCount) return []
	return [
		{
			rule: 'constantBodyViolationCount',
			file: null,
			message: `${actual} Logger call(s) have a non-constant message body (a template literal with a hole, or a ` +
				`\`+\` concatenation) as the first argument; scripts/log-standard.json#constantBodyViolationCount ` +
				`records ${config.constantBodyViolationCount}. The ratchet fails on any mismatch, not only an increase — ` +
				'move the variable into a namespaced attribute instead of editing the count to make this pass.',
		},
	]
	// MUTATION-MARKER:constantBody:END
}

export function checkNamespacedAttributeKeys(program, fullPaths, config) {
	// MUTATION-MARKER:namespacedAttributeKeys:START
	const actual = countNamespacedAttributeKeyViolations(program, fullPaths)
	if (actual === config.namespacedAttributeKeyViolationCount) return []
	return [
		{
			rule: 'namespacedAttributeKeyViolationCount',
			file: null,
			message: `${actual} attribute key(s) across all Logger calls do not match ` +
				'^(namzu|gen_ai|service|exception)\\. — including unresolvable computed keys and attribute bags not ' +
				`provably LogAttributes; scripts/log-standard.json#namespacedAttributeKeyViolationCount records ` +
				`${config.namespacedAttributeKeyViolationCount}. The ratchet fails on any mismatch, not only an increase.`,
		},
	]
	// MUTATION-MARKER:namespacedAttributeKeys:END
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
	// Rules 3 and 4 need real files on disk, not the {rel, text} pairs the
	// six syntax-only checks above use — a ts.Program reads from the
	// filesystem itself via its CompilerHost. Same file set, same scope
	// (packages/*\/src, one level below packages/), just addressed by path
	// instead of pre-loaded text.
	const fullPaths = collectSourceFiles().map(({ full }) => full)
	const program = buildProgram(fullPaths)

	if (process.argv.includes('--write')) {
		const nextGetRootLoggerCount = countSdkOnlyOccurrences(fileEntries, isGetRootLoggerCall)
		const nextUnnamespacedBindingCount = countSdkOnlyOccurrences(fileEntries, isComponentBinding)
		const nextConstantBodyViolationCount = countConstantBodyViolations(program, fullPaths)
		const nextNamespacedAttributeKeyViolationCount = countNamespacedAttributeKeyViolations(program, fullPaths)
		const next = {
			...config,
			getRootLoggerCount: nextGetRootLoggerCount,
			unnamespacedBindingCount: nextUnnamespacedBindingCount,
			constantBodyViolationCount: nextConstantBodyViolationCount,
			namespacedAttributeKeyViolationCount: nextNamespacedAttributeKeyViolationCount,
		}
		writeFileSync(configPath, `${JSON.stringify(next, null, '\t')}\n`)
		console.log(
			`scripts/log-standard.json written: getRootLoggerCount ${config.getRootLoggerCount} -> ` +
				`${nextGetRootLoggerCount}, unnamespacedBindingCount ${config.unnamespacedBindingCount} -> ` +
				`${nextUnnamespacedBindingCount}, constantBodyViolationCount ${config.constantBodyViolationCount} -> ` +
				`${nextConstantBodyViolationCount}, namespacedAttributeKeyViolationCount ` +
				`${config.namespacedAttributeKeyViolationCount} -> ${nextNamespacedAttributeKeyViolationCount}`,
		)
		console.log(
			'The console.* and stream-write allowlists, and the (permanently empty) rule-3/rule-4 excludes lists, are ' +
				'not touched by --write: a new or removed site needs a human-authored reason, not a guess. Edit ' +
				'scripts/log-standard.json directly.',
		)
		process.exit(0)
	}

	const violations = [
		...checkConsoleAllowlist(fileEntries, config),
		...checkStreamWriteAllowlist(fileEntries, config),
		...checkGetRootLoggerRatchet(fileEntries, config),
		...checkUnnamespacedBindingRatchet(fileEntries, config),
		...checkConstantBody(program, fullPaths, config),
		...checkNamespacedAttributeKeys(program, fullPaths, config),
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
