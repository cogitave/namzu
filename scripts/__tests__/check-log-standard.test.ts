/**
 * Tests for scripts/check-log-standard.mjs.
 *
 * Uses `node:test` and `node:assert/strict` rather than vitest, which is
 * every other test in this repo. That is a deliberate exception, not an
 * oversight: this file has no package of its own, and every existing vitest
 * config in the tree is scoped to one package's `src/` — there is nowhere to
 * hang a root-level `scripts/` suite on the existing infrastructure without
 * either duplicating a package's test run under a different root or adding a
 * new root-level vitest project. `tsx` is already a root devDependency (the
 * `namzu` script runs the CLI through it), so `node --import tsx --test
 * scripts/__tests__/check-log-standard.test.ts` runs this file with zero new
 * dependencies and zero lockfile changes. Run via `pnpm test:scripts`.
 *
 * Not covered by `pnpm typecheck`: root tsconfig.json's project references
 * list only packages/*, so a type error in this file surfaces only at
 * `--import tsx --test` runtime, not in the dedicated Type check CI step.
 * Consistent with the rest of scripts/ having no static type coverage today.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

import {
	checkConsoleAllowlist,
	checkStreamWriteAllowlist,
	checkGetRootLoggerRatchet,
	checkUnnamespacedBindingRatchet,
	checkConstantBody,
	checkNamespacedAttributeKeys,
	namespacedAttributeKeyDetails,
} from '../check-log-standard.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(__dirname, '..', 'check-log-standard.mjs')
const scriptSource = readFileSync(scriptPath, 'utf8')
const fixturesDir = join(__dirname, '..', '__fixtures__', 'log-standard')
const repoRoot = join(__dirname, '..', '..')

function readFixture(name) {
	return readFileSync(join(fixturesDir, name), 'utf8')
}

// ---------------------------------------------------------------------------
// The four rules, each on its own deliberately-violating fixture. Every
// assertion compares the full violation SET (rule + file, via
// assert.deepEqual on a projected array) rather than checking that one
// expected item is present among possibly-others — the difference the task
// calls out explicitly: a `toContain`-shaped assertion cannot see an EXTRA,
// unexpected violation, only a missing one.
// ---------------------------------------------------------------------------

describe('checkConsoleAllowlist', () => {
	const REL = 'scripts/__fixtures__/log-standard/console-violation.ts'
	const text = readFixture('console-violation.ts')

	test('an unlisted console.error call is reported, naming the file (dies to: deleting the console rule — see mutation proof below)', () => {
		const violations = checkConsoleAllowlist([{ rel: REL, text }], { consoleAllowlist: [] })
		assert.deepEqual(
			violations.map((v) => ({ rule: v.rule, file: v.file })),
			[{ rule: 'console-allowlist', file: REL }],
		)
	})

	test('the same call passes once enumerated with a matching count (dies to: compareAllowlist ignoring the allowlist entirely)', () => {
		const violations = checkConsoleAllowlist(
			[{ rel: REL, text }],
			{ consoleAllowlist: [{ file: REL, symbol: 'console.error', count: 1, reason: 'test' }] },
		)
		assert.deepEqual(violations, [])
	})

	test('a fifth call past an allowed count of four fails and names the file (dies to: comparing with >= instead of ===, which would let unlimited calls through once one is allowed)', () => {
		const base = Array.from({ length: 4 }, () => "console.error('boom')\n").join('')
		const augmented = `${base}console.error('one more')\n`
		const allowlist = [{ file: 'synthetic.ts', symbol: 'console.error', count: 4, reason: 'test' }]

		assert.deepEqual(checkConsoleAllowlist([{ rel: 'synthetic.ts', text: base }], { consoleAllowlist: allowlist }), [])

		const violations = checkConsoleAllowlist([{ rel: 'synthetic.ts', text: augmented }], { consoleAllowlist: allowlist })
		assert.equal(violations.length, 1)
		assert.equal(violations[0].file, 'synthetic.ts')
	})

	test('an allowlist entry with zero remaining calls fails too — removal without editing the JSON (dies to: only checking actual > allowed, never actual < allowed)', () => {
		const allowlist = [{ file: 'synthetic.ts', symbol: 'console.error', count: 1, reason: 'test' }]
		const violations = checkConsoleAllowlist([{ rel: 'synthetic.ts', text: '// no console calls here\n' }], { consoleAllowlist: allowlist })
		assert.equal(violations.length, 1)
		assert.equal(violations[0].file, 'synthetic.ts')
	})
})

describe('checkStreamWriteAllowlist', () => {
	const REL = 'scripts/__fixtures__/log-standard/stream-write-violation.ts'
	const text = readFixture('stream-write-violation.ts')

	test('an unlisted process.stdout.write call is reported, naming the file (dies to: deleting the stream-write rule — see mutation proof below)', () => {
		const violations = checkStreamWriteAllowlist([{ rel: REL, text }], { streamWriteAllowlist: [] })
		assert.deepEqual(
			violations.map((v) => ({ rule: v.rule, file: v.file })),
			[{ rule: 'stream-write-allowlist', file: REL }],
		)
	})

	test('the same call passes once enumerated with a matching count', () => {
		const violations = checkStreamWriteAllowlist(
			[{ rel: REL, text }],
			{ streamWriteAllowlist: [{ file: REL, symbol: 'process.stdout.write', count: 1, reason: 'test' }] },
		)
		assert.deepEqual(violations, [])
	})

	test('process.stderr.write is a different symbol from process.stdout.write and is not excused by an stdout entry (dies to: keying the allowlist by file alone, dropping the symbol)', () => {
		// The stdout.write call stays in the text (and in the allowlist) so
		// that entry is satisfied; only the appended stderr.write call is
		// unauthorized. Replacing the text outright, rather than appending,
		// would also flag the now-unmatched stdout.write entry as stale —
		// a correct violation, but a different one than this test names.
		const violations = checkStreamWriteAllowlist(
			[{ rel: REL, text: `${text}process.stderr.write("x")\n` }],
			{ streamWriteAllowlist: [{ file: REL, symbol: 'process.stdout.write', count: 1, reason: 'test' }] },
		)
		assert.equal(violations.length, 1)
		assert.match(violations[0].message, /process\.stderr\.write/)
	})
})

describe('checkGetRootLoggerRatchet', () => {
	// Fabricated: the fixture lives under scripts/__fixtures__/log-standard/,
	// but the rule only counts inside packages/sdk/src/. See the fixture's
	// own header comment.
	const FIXTURE_REL = 'packages/sdk/src/__test-fixture__.ts'
	const text = readFixture('get-root-logger-violation.ts')

	test('passes when the stored count matches the one real call', () => {
		assert.deepEqual(checkGetRootLoggerRatchet([{ rel: FIXTURE_REL, text }], { getRootLoggerCount: 1 }), [])
	})

	test('fails when a call was added without updating the JSON (stored 0, actual 1) (dies to: comparing with > instead of !==)', () => {
		const violations = checkGetRootLoggerRatchet([{ rel: FIXTURE_REL, text }], { getRootLoggerCount: 0 })
		assert.equal(violations.length, 1)
		assert.equal(violations[0].rule, 'getRootLoggerCount')
	})

	test('fails when a call was removed without updating the JSON (stored 2, actual 1) — the direction a > comparison would miss', () => {
		const violations = checkGetRootLoggerRatchet([{ rel: FIXTURE_REL, text }], { getRootLoggerCount: 2 })
		assert.equal(violations.length, 1)
		assert.equal(violations[0].rule, 'getRootLoggerCount')
	})

	test('a file outside packages/sdk/src/ is invisible to this rule (dies to: dropping the scope filter)', () => {
		assert.deepEqual(
			checkGetRootLoggerRatchet([{ rel: 'packages/cli/src/__test-fixture__.ts', text }], { getRootLoggerCount: 0 }),
			[],
		)
	})
})

describe('checkUnnamespacedBindingRatchet', () => {
	const FIXTURE_REL = 'packages/sdk/src/__test-fixture__.ts'
	const text = readFixture('unnamespaced-binding-violation.ts')

	test('passes when the stored count matches the one real binding', () => {
		assert.deepEqual(checkUnnamespacedBindingRatchet([{ rel: FIXTURE_REL, text }], { unnamespacedBindingCount: 1 }), [])
	})

	test('fails in both directions around the one real binding (dies to: comparing with > instead of !==)', () => {
		assert.equal(checkUnnamespacedBindingRatchet([{ rel: FIXTURE_REL, text }], { unnamespacedBindingCount: 0 }).length, 1)
		assert.equal(checkUnnamespacedBindingRatchet([{ rel: FIXTURE_REL, text }], { unnamespacedBindingCount: 2 }).length, 1)
	})

	test('the shorthand form { component } counts exactly like { component: x } (dies to: matching only ts.isPropertyAssignment)', () => {
		const violations = checkUnnamespacedBindingRatchet(
			[{ rel: FIXTURE_REL, text: "const component = 'X'\nlog.child({ component })\n" }],
			{ unnamespacedBindingCount: 1 },
		)
		assert.deepEqual(violations, [])
	})
})

// ---------------------------------------------------------------------------
// The two type-aware rules (LOG-13). Neither can run on synthetic in-memory
// text the way the four rules above do — both turn on a DECLARED TYPE, and
// there is no type without a real Program resolving real imports. Every
// fixture these two rules run against is consequently a REAL file on disk
// under scripts/__fixtures__/log-standard/, importing the ACTUAL `Logger`
// and `LogAttributes` types from packages/sdk/src — per
// fixture-must-match-production, never a hand-rolled stand-in interface.
// Each describe block below builds its OWN small ts.Program over just the
// fixture(s) it needs (a handful of files, not the whole 600+-file
// workspace `main()` builds one over) — fast, and exactly the `program`
// shape checkConstantBody/checkNamespacedAttributeKeys expect.
// ---------------------------------------------------------------------------

const FIXTURE_PROGRAM_OPTIONS = {
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.NodeNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
	types: ['node'],
	esModuleInterop: true,
	skipLibCheck: true,
	noEmit: true,
}

function buildFixtureProgram(fileNames) {
	return ts.createProgram(fileNames, FIXTURE_PROGRAM_OPTIONS)
}

describe('checkConstantBody', () => {
	const FIXTURE = join(fixturesDir, 'constant-body-violation.ts')
	const program = buildFixtureProgram([FIXTURE])

	test('passes when the stored count matches the two real violations — a template literal with a hole, and a `+` concatenation', () => {
		assert.deepEqual(checkConstantBody(program, [FIXTURE], { constantBodyViolationCount: 2 }), [])
	})

	test('fails in both directions around the two real violations (dies to: comparing with > instead of !==)', () => {
		assert.equal(checkConstantBody(program, [FIXTURE], { constantBodyViolationCount: 1 }).length, 1)
		assert.equal(checkConstantBody(program, [FIXTURE], { constantBodyViolationCount: 3 }).length, 1)
	})

	test('a no-substitution template literal and a plain string body both stay outside the count (dies to: flagging every template literal, hole or not)', () => {
		// The fixture's third call — log.debug('constant body, passes', ...) —
		// is already excluded from the count of 2 asserted above. This test
		// names that fact directly rather than leaving it implicit in the
		// arithmetic: if a mutant flagged EVERY template literal regardless of
		// substitutions, the debug() call's plain string would still not be a
		// template literal at all, so that specific mutant would not be caught
		// here — the next test (receiver-type resolution) and the mutation
		// proof below are what catch a `TemplateExpression`-vs-any-template
		// confusion; this one documents the debug() call is deliberately inert.
		assert.deepEqual(checkConstantBody(program, [FIXTURE], { constantBodyViolationCount: 2 }), [])
	})

	describe('receiver-type resolution', () => {
		const RECEIVER_FIXTURE = join(fixturesDir, 'receiver-type-violation.ts')
		const receiverProgram = buildFixtureProgram([RECEIVER_FIXTURE])

		test('an aliased Logger, a destructured Logger, and a structurally non-Logger object with the same three method names all resolve correctly: the count is exactly 2, not 3 (dies to: matching the method NAME instead of the receiver TYPE, which would also flag the non-Logger call and count 3)', () => {
			assert.deepEqual(checkConstantBody(receiverProgram, [RECEIVER_FIXTURE], { constantBodyViolationCount: 2 }), [])
			assert.equal(checkConstantBody(receiverProgram, [RECEIVER_FIXTURE], { constantBodyViolationCount: 3 }).length, 1)
		})
	})
})

describe('checkNamespacedAttributeKeys', () => {
	const FIXTURE = join(fixturesDir, 'attribute-key-violation.ts')
	const program = buildFixtureProgram([FIXTURE])

	test('passes when the stored count matches the six real violations', () => {
		assert.deepEqual(checkNamespacedAttributeKeys(program, [FIXTURE], { namespacedAttributeKeyViolationCount: 6 }), [])
	})

	test('fails in both directions around the six real violations (dies to: comparing with > instead of !==)', () => {
		assert.equal(checkNamespacedAttributeKeys(program, [FIXTURE], { namespacedAttributeKeyViolationCount: 5 }).length, 1)
		assert.equal(checkNamespacedAttributeKeys(program, [FIXTURE], { namespacedAttributeKeyViolationCount: 7 }).length, 1)
	})

	// The property-access fold, both directions, as its own assertion
	// rather than folded into the count: a count that moved from 5 to 6
	// would be satisfied by the `as const` case regressing and the widened
	// case being added, which is the opposite of what this proves.
	test('a computed key reading an `as const` table folds; the same access on a widened table does not (dies to: folding by declaration instead of by type, which would accept both)', () => {
		const keys = namespacedAttributeKeyDetails(program, [FIXTURE])
		assert.equal(keys.filter((d) => d.includes('namzu.run.id')).length, 0)
		assert.equal(keys.filter((d) => d.includes('computed attribute key')).length, 2)
	})

	// The fixture's six violations, named explicitly so the count of 6
	// above is not the only place this suite states what it is proving:
	//   - a literal un-namespaced key ('a' call: { requestId })
	//   - a shorthand un-namespaced key ('b' call: { id })
	//   - a computed key that does not fold to a literal string ('d' call)
	//   - an untyped identifier whose OWN shape is un-namespaced ('h' call:
	//     `badBag`) — the case a bare `isTypeAssignableTo(t, LogAttributes)`
	//     (one direction only) would have missed, because a mapped type over
	//     a template-literal key pattern tolerates an object with an extra,
	//     unlisted property on that permissive side. Bidirectional
	//     assignability is what rejects it — see checkAttributeBag's own
	//     comment in the script for the measured example.
	//   - a spread of a plain, un-namespaced object ('j' call: `...untypedExtra`)
	//   - a computed key reading a table that is NOT `as const` ('l' call:
	//     `WIDENED.RUN_ID`, whose type is `string`) — the fold goes through
	//     the TYPE so that a mutable property is refused
	// and, NOT counted among the five, on purpose:
	//   - a computed key that DOES fold to a literal ('c' call,
	//     EVENT_NAME_ATTRIBUTE-shaped) — proves computed keys are resolved,
	//     not universally rejected
	//   - a plain namespaced literal key ('e' call)
	//   - an identifier and a function call, each explicitly typed/declared
	//     to return LogAttributes ('f' and 'g' calls)
	//   - a spread of a LogAttributes-typed value ('i' call)
	//   - a computed key reading an `as const` table ('k' call:
	//     `ATTRS.RUN_ID`) — the real constants-table shape, which the rule
	//     used to count as unresolvable while rewarding the hand-typed
	//     string that says the same thing
	// A single count assertion cannot show its work per-case, so this
	// comment is the record of what the number actually verifies.
	test('the computed-key and structural-type paths are both exercised, not skipped (dies to: a literal-key-only walk, which would report 4 instead of 6 — silently passing the unresolvable computed keys)', () => {
		assert.deepEqual(checkNamespacedAttributeKeys(program, [FIXTURE], { namespacedAttributeKeyViolationCount: 6 }), [])
	})

	describe('receiver-type resolution', () => {
		const RECEIVER_FIXTURE = join(fixturesDir, 'receiver-type-violation.ts')
		const receiverProgram = buildFixtureProgram([RECEIVER_FIXTURE])

		test('an un-namespaced key on a structurally non-Logger receiver is not counted (dies to: checking attribute keys by call shape alone, without first confirming the receiver is a Logger)', () => {
			assert.deepEqual(
				checkNamespacedAttributeKeys(receiverProgram, [RECEIVER_FIXTURE], { namespacedAttributeKeyViolationCount: 0 }),
				[],
			)
		})
	})
})

// ---------------------------------------------------------------------------
// The rule-3/rule-4 ratchets carry no path-based suppression, unlike the
// console/stream-write allowlists — by design (LOG-13's acceptance): a path
// excluded from "is this receiver a Logger" or "is this key namespaced" is a
// path where an operator cannot trust either guarantee. These two config
// keys exist ONLY so this test has something to fail against —
// checkConstantBody and checkNamespacedAttributeKeys never read them, so
// populating one would not even suppress anything; it would just leave this
// test as the one honest signal that someone tried.
// ---------------------------------------------------------------------------

test('the rule-3 and rule-4 excludes lists in log-standard.json stay empty (dies to: adding a per-file exclusion for either rule)', () => {
	const config = JSON.parse(readFileSync(join(__dirname, '..', 'log-standard.json'), 'utf8'))
	assert.deepEqual(config.constantBodyExcludes, [])
	assert.deepEqual(config.namespacedAttributeKeyExcludes, [])
})

// ---------------------------------------------------------------------------
// Mutation proof (per docs/conventions/mutation-check-every-test.md): for
// each rule, stub its ENTIRE check-function body to `return []` inside a
// throwaway copy of the real script's source — a literal textual deletion,
// not a testing knob — and confirm the fixture that fails against the real
// module passes against the mutated one. A rule whose deletion changes
// nothing was never enforcing anything.
// ---------------------------------------------------------------------------

const tempDirs = []
after(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

async function importWithRuleDeleted(markerName) {
	const startTag = `\t// MUTATION-MARKER:${markerName}:START`
	const endTag = `\t// MUTATION-MARKER:${markerName}:END`
	const start = scriptSource.indexOf(startTag)
	const end = scriptSource.indexOf(endTag)
	assert.notEqual(start, -1, `marker not found: ${markerName}:START`)
	assert.notEqual(end, -1, `marker not found: ${markerName}:END`)
	const mutated = `${scriptSource.slice(0, start)}\treturn []\n${scriptSource.slice(end + endTag.length)}`
	const dir = mkdtempSync(join(tmpdir(), 'log-standard-mutation-'))
	tempDirs.push(dir)
	// The mutated copy still does `import ts from 'typescript'` at its top —
	// only the marked rule body is stubbed, not the imports — and node_modules
	// resolution walks up from the file's OWN location, which is now a bare
	// tmpdir with no ancestor node_modules. Link the real one in so the
	// import resolves exactly as it does for the unmutated module.
	symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'))
	const file = join(dir, 'check-log-standard.mutated.mjs')
	writeFileSync(file, mutated)
	return import(pathToFileURL(file).href)
}

describe('mutation proof', () => {
	const cases = [
		{
			marker: 'console',
			fileEntries: () => [{ rel: 'x.ts', text: readFixture('console-violation.ts') }],
			config: { consoleAllowlist: [] },
			run: (mod, entries, config) => mod.checkConsoleAllowlist(entries, config),
		},
		{
			marker: 'streamWrite',
			fileEntries: () => [{ rel: 'x.ts', text: readFixture('stream-write-violation.ts') }],
			config: { streamWriteAllowlist: [] },
			run: (mod, entries, config) => mod.checkStreamWriteAllowlist(entries, config),
		},
		{
			marker: 'getRootLogger',
			fileEntries: () => [{ rel: 'packages/sdk/src/x.ts', text: readFixture('get-root-logger-violation.ts') }],
			config: { getRootLoggerCount: 0 },
			run: (mod, entries, config) => mod.checkGetRootLoggerRatchet(entries, config),
		},
		{
			marker: 'unnamespacedBinding',
			fileEntries: () => [{ rel: 'packages/sdk/src/x.ts', text: readFixture('unnamespaced-binding-violation.ts') }],
			config: { unnamespacedBindingCount: 0 },
			run: (mod, entries, config) => mod.checkUnnamespacedBindingRatchet(entries, config),
		},
	]

	for (const { marker, fileEntries, config, run } of cases) {
		test(`deleting the ${marker} rule flips its fixture from failing to passing`, async () => {
			const real = { checkConsoleAllowlist, checkStreamWriteAllowlist, checkGetRootLoggerRatchet, checkUnnamespacedBindingRatchet }
			const before = run(real, fileEntries(), config)
			assert.ok(before.length > 0, `expected the real ${marker} rule to report a violation on its own fixture`)

			const mutated = await importWithRuleDeleted(marker)
			const afterDeletion = run(mutated, fileEntries(), config)
			assert.deepEqual(afterDeletion, [], `expected deleting ${marker} to make its fixture pass; it still reported a violation`)
		})
	}
})

// The two type-aware rules take (program, fullPaths, config) rather than
// (fileEntries, config) — a Program is not fixture text, and building one
// belongs in THIS file (the real `ts` import), not inside the mutated
// module — so they get their own small loop instead of joining `cases`
// above rather than forcing an awkward shared shape onto both kinds of rule.
describe('mutation proof — type-aware rules', () => {
	const typeAwareCases = [
		{
			marker: 'constantBody',
			fixture: 'constant-body-violation.ts',
			config: { constantBodyViolationCount: 0 },
			run: (mod, fullPaths, config) => mod.checkConstantBody(buildFixtureProgram(fullPaths), fullPaths, config),
		},
		{
			marker: 'namespacedAttributeKeys',
			fixture: 'attribute-key-violation.ts',
			config: { namespacedAttributeKeyViolationCount: 0 },
			run: (mod, fullPaths, config) => mod.checkNamespacedAttributeKeys(buildFixtureProgram(fullPaths), fullPaths, config),
		},
	]

	for (const { marker, fixture, config, run } of typeAwareCases) {
		test(`deleting the ${marker} rule flips its fixture from failing to passing`, async () => {
			const fullPaths = [join(fixturesDir, fixture)]
			const real = { checkConstantBody, checkNamespacedAttributeKeys }
			const before = run(real, fullPaths, config)
			assert.ok(before.length > 0, `expected the real ${marker} rule to report a violation on its own fixture`)

			const mutated = await importWithRuleDeleted(marker)
			const afterDeletion = run(mutated, fullPaths, config)
			assert.deepEqual(afterDeletion, [], `expected deleting ${marker} to make its fixture pass; it still reported a violation`)
		})
	}
})

// ---------------------------------------------------------------------------
// No escape hatch.
// ---------------------------------------------------------------------------

test('the script has no env-var escape hatch — it never reads process.env (dies to: adding a SKIP_LOG_STANDARD-style bypass)', () => {
	const hits = scriptSource.match(/process\.env/g) ?? []
	assert.equal(hits.length, 0, `found ${hits.length} process.env reference(s) in check-log-standard.mjs`)
})

// ---------------------------------------------------------------------------
// Integration: the real gate, against the real tree, run as a subprocess —
// not just the unit-level check functions above. Every check above proves
// the rule logic is sound in isolation; only this proves the numbers
// currently recorded in log-standard.json actually describe packages/*/src
// on this commit. It is the one test in this file that goes red on its own,
// with no code change, the moment the tree drifts from the file — now
// including the two type-aware ratchets, since main() builds its own
// Program over the whole tree and calls checkConstantBody /
// checkNamespacedAttributeKeys the same as the four syntax-only rules.
// ---------------------------------------------------------------------------

test('node scripts/check-log-standard.mjs exits 0 against the tree as it stands', () => {
	const stdout = execFileSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: 'utf8' })
	assert.match(stdout, /log standard gate passed/)
})
