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

import {
	checkConsoleAllowlist,
	checkStreamWriteAllowlist,
	checkGetRootLoggerRatchet,
	checkUnnamespacedBindingRatchet,
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
// with no code change, the moment the tree drifts from the file.
// ---------------------------------------------------------------------------

test('node scripts/check-log-standard.mjs exits 0 against the tree as it stands', () => {
	const stdout = execFileSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: 'utf8' })
	assert.match(stdout, /log standard gate passed/)
})
