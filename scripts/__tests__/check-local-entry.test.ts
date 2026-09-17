/**
 * Tests for scripts/check-local-entry.mjs.
 *
 * node:test and node:assert/strict, like the other files in this directory and
 * unlike every test inside a package. `scripts/` belongs to no package, so
 * `pnpm -r test` cannot reach it and the workflow step that names this file is
 * the only thing that ever runs it. `pnpm typecheck` does not cover it either —
 * root tsconfig.json's project references list only packages/* — so a type
 * error here surfaces at `--import tsx --test` runtime, not in the Type check
 * step.
 *
 * ## Why the absence cases run against a synthetic root
 *
 * The behaviour under test is what the script says about a tree that does not
 * contain a local-only package, and whether THIS checkout contains one is
 * exactly what differs between the owner's machine (where `packages/api`
 * exists) and CI (where it does not). A test pointed at the real tree would
 * then be green in one place and red in the other while running the same code,
 * which is a test reporting the machine rather than the script. So the
 * fixtures build their own trees and reach them through `--root`, seeded by
 * default with the REAL `.gitignore` and `pnpm-workspace.yaml` — a fixture
 * that retyped them would let the arrangement drift out from under the
 * assertions about it, and one of those assertions is that the two files agree.
 * The one case that does use the real tree names a TRACKED file
 * (`packages/cli/src/bin.ts`), present in every checkout by construction.
 *
 * ## What the message must not say
 *
 * The sentence exists to send a reader to the right file with the right
 * question, so most of what is asserted below is NEGATIVE: `dist/` is never
 * called a local-only package, a package `pnpm-workspace.yaml` does not
 * exclude is never described as excluded by it, and a path no entry covers is
 * never described by an entry that does not cover it. Each of those was a real
 * wrong sentence once, and each assertion names the shape it is forbidding.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(__dirname, '..', 'check-local-entry.mjs')
const scriptSource = readFileSync(scriptPath, 'utf8')
const repoRoot = join(__dirname, '..', '..')

const REAL_GITIGNORE = readFileSync(join(repoRoot, '.gitignore'), 'utf8')
const REAL_WORKSPACE = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')

const tempDirs = []
after(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/**
 * A synthetic checkout: the two files the script reads, plus whichever entry
 * points a case needs present. Both default to the real ones, so the sentence
 * under assertion is the one this repository actually produces; a case that
 * needs a different arrangement says so by passing a replacement.
 */
function checkout({ gitignore = REAL_GITIGNORE, workspace = REAL_WORKSPACE, present = [] } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'namzu-local-entry-'))
	tempDirs.push(root)
	writeFileSync(join(root, '.gitignore'), gitignore)
	writeFileSync(join(root, 'pnpm-workspace.yaml'), workspace)
	for (const rel of present) {
		mkdirSync(dirname(join(root, rel)), { recursive: true })
		writeFileSync(join(root, rel), '// present\n')
	}
	return root
}

function spawn(args, cwd) {
	const result = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', cwd })
	return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function run(...args) {
	return spawn(args, undefined)
}

/**
 * The packages `.gitignore` names under its "Local-only packages" heading, as
 * this test reads the rule.
 *
 * The heading is located rather than assumed: falling back to the top of the
 * file would find `node_modules` and `dist` and quietly answer with the wrong
 * set, which is the shape of mistake this whole file is about.
 */
function localOnlyPackages(root) {
	const lines = readFileSync(join(root, '.gitignore'), 'utf8')
		.split('\n')
		.map((line) => line.trim())
	const heading = lines.findIndex((line) => /^#.*local-only packages/i.test(line))
	assert.notEqual(heading, -1, `${root}/.gitignore has no "Local-only packages" heading — this test is stale`)

	const found = []
	for (const line of lines.slice(heading + 1)) {
		if (line === '' || line.startsWith('#')) break
		if (line.startsWith('!') || line.includes('*')) continue
		found.push(line.replace(/\/+$/, ''))
	}
	return found
}

/** The negated globs `pnpm-workspace.yaml` keeps packages out of the workspace with. */
function workspaceExclusions(root) {
	return [...readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').matchAll(/^\s*-\s*"!(.+?)"\s*$/gm)].map((m) =>
		m[1].replace(/\/+$/, ''),
	)
}

// ---------------------------------------------------------------------------
// The entry point is absent. This is the whole reason the script exists: the
// bare `ERR_MODULE_NOT_FOUND` it replaces named a file and said nothing about
// why the file was gone.
// ---------------------------------------------------------------------------

describe('the entry point is absent', () => {
	test('names the missing path, the local-only package that owns it, and both files the arrangement is written down in, then exits 1', () => {
		const root = checkout()
		const { status, stdout, stderr } = run('--root', root, 'packages/api/src/server.ts')

		assert.equal(status, 1)
		// The sentence is a diagnostic, so it goes to stderr and stdout stays
		// clean — the command after the `&&` never runs, and a caller
		// redirecting stdout gets nothing that looks like the program's output.
		assert.equal(stdout, '')
		assert.equal(
			stderr.trimEnd(),
			'packages/api/src/server.ts is missing: packages/api is a local-only package, listed under "Local-only packages" in .gitignore and excluded from the workspace in pnpm-workspace.yaml, so a fresh checkout does not contain it.',
		)
	})

	test('is one sentence on one line (dies to: a message that grows a stack of hints, which is the shape a reader stops reading)', () => {
		const root = checkout()
		const { stderr } = run('--root', root, 'packages/api/src/server.ts')
		assert.equal(stderr.trimEnd().split('\n').length, 1)
	})

	test('a local-only package pnpm-workspace.yaml does NOT exclude gets the .gitignore clause alone (dies to: quoting the second file into agreement, which sends the reader to look for an exclusion that is not there)', () => {
		// `packages/ghost` inside the block, and absent from the workspace
		// exclusions — the combination that must NOT be reported as excluded.
		const gitignore = '# Local-only packages\npackages/api/\npackages/ghost/\n'
		const root = checkout({ gitignore })
		const { status, stderr } = run('--root', root, 'packages/ghost/src/index.ts')

		assert.equal(status, 1)
		assert.equal(
			stderr.trimEnd(),
			'packages/ghost/src/index.ts is missing: packages/ghost is a local-only package, listed under "Local-only packages" in .gitignore, so a fresh checkout does not contain it.',
		)
		assert.doesNotMatch(stderr, /pnpm-workspace\.yaml/)
	})

	test('an entry that names a directory without a trailing slash still covers it (dies to: requiring the slashed spelling, which loses the whole arrangement the day someone respells it)', () => {
		const gitignore = REAL_GITIGNORE.replace('packages/api/', 'packages/api')
		const root = checkout({ gitignore })
		const { stderr } = run('--root', root, 'packages/api/src/server.ts')
		assert.match(stderr, /packages\/api is a local-only package/)
	})

	test('a path under an ignored directory that is NOT in the local-only block is not called a local-only package (dies to: calling every .gitignore directory one, which reported "dist is a local-only package")', () => {
		const root = checkout()
		for (const entry of ['dist/index.js', 'coverage/lcov.info']) {
			const { status, stderr } = run('--root', root, entry)
			assert.equal(status, 1)
			assert.match(stderr, new RegExp(`^${entry.replace(/[.]/g, '\\.')} is missing: \\.gitignore excludes `))
			assert.doesNotMatch(stderr, /is a local-only package/)
			assert.doesNotMatch(stderr, /pnpm-workspace\.yaml/)
		}
	})

	test('a path no entry covers claims no arrangement at all (dies to: describing an unexplained absence with the reason this script exists to report)', () => {
		const root = checkout()
		const { status, stderr } = run('--root', root, 'packages/ghost/src/index.ts')

		assert.equal(status, 1)
		assert.match(stderr, /^packages\/ghost\/src\/index\.ts is missing: no \.gitignore entry covers it/)
		assert.doesNotMatch(stderr, /is a local-only package/)
	})

	test('the narrowest covering entry names the package, not the broadest (dies to: taking the first match, which would say `packages` here)', () => {
		const gitignore = '# Local-only packages\npackages/\npackages/api/\n'
		const root = checkout({ gitignore })
		const { stderr } = run('--root', root, 'packages/api/src/server.ts')
		assert.match(stderr, /packages\/api is a local-only package/)
	})

	test('every named path is checked, not only the first (dies to: returning on the first missing path, which would hide the rest of a command line)', () => {
		const root = checkout({ present: ['packages/cli/src/bin.ts'] })
		const { status, stderr } = run(
			'--root',
			root,
			'packages/cli/src/bin.ts',
			'packages/api/src/server.ts',
			'packages/agents/src/index.ts',
		)

		assert.equal(status, 1)
		assert.doesNotMatch(stderr, /packages\/cli/)
		assert.match(stderr, /packages\/api\/src\/server\.ts is missing/)
		assert.match(stderr, /packages\/agents\/src\/index\.ts is missing/)
	})
})

// ---------------------------------------------------------------------------
// The entry point is present. This is the direction that has to be boring:
// a developer who has the package runs `pnpm api` and sees exactly what they
// saw before the preflight existed — the program, and nothing else.
// ---------------------------------------------------------------------------

describe('the entry point is present', () => {
	test('prints nothing at all and exits 0 (dies to: a preflight that reports its success, which would be noise in front of every `tsx watch` run)', () => {
		const root = checkout({ present: ['packages/api/src/server.ts'] })
		const { status, stdout, stderr } = run('--root', root, 'packages/api/src/server.ts')

		assert.equal(status, 0)
		assert.equal(stdout, '')
		assert.equal(stderr, '')
	})

	test('the real checkout accepts a tracked entry point, from outside the repository (dies to: resolving entry paths against the caller`s cwd, which would make the same command work from the root and fail from anywhere else)', () => {
		const { status, stdout, stderr } = spawn(['packages/cli/src/bin.ts'], tmpdir())
		assert.equal(status, 0)
		assert.equal(stdout, '')
		assert.equal(stderr, '')
	})
})

// ---------------------------------------------------------------------------
// A broken invocation. The failure this guards against is a preflight that
// checks nothing and reports success, which is the one outcome worse than no
// preflight at all.
// ---------------------------------------------------------------------------

describe('a broken invocation', () => {
	test('no path exits 2 with the usage line, rather than silently checking nothing', () => {
		const { status, stderr } = run()
		assert.equal(status, 2)
		assert.match(stderr, /usage: node scripts\/check-local-entry\.mjs/)
	})

	test('an EMPTY path exits 2 rather than 0 (dies to: treating "" as an entry point that exists — `node scripts/check-local-entry.mjs "$ENTRY" && tsx "$ENTRY"` with $ENTRY unset would then pass green and hand the reader the bare error this script exists to replace)', () => {
		const { status, stdout, stderr } = run('')
		assert.equal(status, 2)
		assert.equal(stdout, '')
		assert.match(stderr, /an entry point cannot be an empty string/)
	})

	test('`-` is refused as an option rather than read as a filename (dies to: letting it through as a path, which reported "- is missing")', () => {
		const { status, stderr } = run('-')
		assert.equal(status, 2)
		assert.match(stderr, /unknown option: -/)
	})

	test('--root with no value exits 2, and so does an empty one', () => {
		for (const args of [['--root'], ['--root', '']]) {
			const { status, stderr } = run(...args)
			assert.equal(status, 2)
			assert.match(stderr, /--root needs a directory/)
		}
	})

	test('an unknown flag exits 2 rather than being read as a path (dies to: ignoring unrecognised arguments, which turns a typo into a passing check)', () => {
		const { status, stderr } = run('--skip', 'packages/api/src/server.ts')
		assert.equal(status, 2)
		assert.match(stderr, /unknown option: --skip/)
	})
})

// ---------------------------------------------------------------------------
// Mutation proof. Delete the one line that carries the verdict and the same
// fixture must stop failing: an assertion on `status === 1` is only worth
// anything if the status can be zero for the reason the check exists.
// ---------------------------------------------------------------------------

describe('mutation proof', () => {
	test('replacing the verdict line with `process.exit(0)` flips the absent case from failing to passing', () => {
		const root = checkout()
		const before = run('--root', root, 'packages/api/src/server.ts')
		assert.equal(before.status, 1, 'expected the real script to fail on a missing entry point')

		const verdict = 'process.exit(missing === 0 ? 0 : 1)'
		assert.ok(scriptSource.includes(verdict), `verdict line not found in check-local-entry.mjs: ${verdict}`)
		const dir = mkdtempSync(join(tmpdir(), 'namzu-local-entry-mutation-'))
		tempDirs.push(dir)
		const mutatedPath = join(dir, 'check-local-entry.mutated.mjs')
		writeFileSync(mutatedPath, scriptSource.replace(verdict, 'process.exit(0)'))

		const after = spawnSync(process.execPath, [mutatedPath, '--root', root, 'packages/api/src/server.ts'], {
			encoding: 'utf8',
		})
		assert.equal(after.status, 0, 'expected the mutated script to report success on the same input')
	})
})

// ---------------------------------------------------------------------------
// The arrangement agrees with itself. Two files state which packages are
// local-only, and a package named by one and not the other is the arrangement
// disagreeing with itself rather than a package that is local-only — which is
// what `packages/contracts` and `packages/docs` were, excluded by neither
// before this was written, while `.gitignore` called both of them local-only.
//
// Nothing failed while that was true, which is why it is asserted here: the
// two lists are hand-maintained, and the next package added to one of them
// will be added to the other only if something says so.
// ---------------------------------------------------------------------------

test('the .gitignore block and the pnpm-workspace.yaml exclusions name the same packages (dies to: excluding only some of them, which leaves the rest matching `packages/*` and so still workspace members)', () => {
	assert.deepEqual(workspaceExclusions(repoRoot).sort(), localOnlyPackages(repoRoot).sort())
})

// ---------------------------------------------------------------------------
// The root scripts are what the preflight is FOR, and nothing about running
// `pnpm api` on this machine proves the NEXT root script added pointing into a
// local-only package will carry it. So the rule is asserted against the file
// that holds the scripts, and against synthetic command lines as well — a
// guard that has only ever run against the file it currently passes is not
// evidence that it would catch anything.
//
// The test states the rule itself — `.gitignore` entries are directory
// prefixes — instead of importing the script's parser: a test that reuses the
// implementation's own idea of "local-only" cannot notice the implementation
// narrowing it.
// ---------------------------------------------------------------------------

const LOCAL_ONLY = localOnlyPackages(repoRoot)

/**
 * The rule over any script table: a command that NAMES a path under a
 * local-only package must carry the preflight for that same path. It is keyed
 * on the path, not on the runner — `tsx`, `tsx watch`, `pnpm exec tsx` and a
 * bare `node` all reach the same missing file, and the bare
 * `ERR_MODULE_NOT_FOUND` this exists to replace is not a tsx-specific error.
 */
function assertPreflightPrecedesLocalPaths(scripts) {
	let checked = 0
	for (const [name, command] of Object.entries(scripts)) {
		for (const token of command.split(/\s+/)) {
			const path = token.replace(/^['"]|['"]$/g, '')
			if (!LOCAL_ONLY.some((dir) => path.startsWith(`${dir}/`))) continue
			checked += 1
			assert.ok(
				command.includes(`node scripts/check-local-entry.mjs ${path} && `),
				`root script "${name}" names ${path} without the local-entry preflight in front of it: ${command}`,
			)
		}
	}
	return checked
}

describe('the root scripts', () => {
	const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

	test('every root script that names a path under a local-only package runs the check first, for that same path', () => {
		// The loop would also pass by finding nothing, which is the failure
		// mode the whole repository calls a check that cannot fail.
		const checked = assertPreflightPrecedesLocalPaths(pkg.scripts)
		assert.ok(checked > 0, `no root script names a local-only path; scanned: ${JSON.stringify(LOCAL_ONLY)}`)
	})

	test('the rule catches a command that names the path without the check, whatever runner it uses (dies to: matching only `tsx` at the start of a command or after `&&`, which lets `node packages/api/src/server.ts` and `pnpm exec tsx …` through)', () => {
		for (const command of [
			'node packages/api/src/server.ts',
			'pnpm exec tsx packages/api/src/server.ts',
			'tsx packages/api/src/server.ts',
			'tsx watch packages/api/src/server.ts',
			'npm run --silent build && node packages/api/src/server.ts',
		]) {
			assert.throws(
				() => assertPreflightPrecedesLocalPaths({ api: command }),
				/without the local-entry preflight/,
				`the rule accepted a command it must refuse: ${command}`,
			)
		}
		assert.ok(
			assertPreflightPrecedesLocalPaths({
				api: 'node scripts/check-local-entry.mjs packages/api/src/server.ts && tsx packages/api/src/server.ts',
			}) >= 1,
		)
	})

	test('api and api:dev still run tsx — the preflight is in front of the command, not instead of it', () => {
		assert.equal(
			pkg.scripts.api,
			'node scripts/check-local-entry.mjs packages/api/src/server.ts && tsx packages/api/src/server.ts',
		)
		assert.equal(
			pkg.scripts['api:dev'],
			'node scripts/check-local-entry.mjs packages/api/src/server.ts && tsx watch packages/api/src/server.ts',
		)
	})
})

// ---------------------------------------------------------------------------
// The wiring that runs this file. `scripts/__tests__/` belongs to no package,
// so `pnpm -r test` cannot reach any of it: a file no workflow names is a test
// that never runs, and the step that names it is the only thing keeping it
// alive. Asserted here rather than left to review, for the reason
// `verify-consumer-install-snapshot.test.ts` asserts the same thing about
// itself.
// ---------------------------------------------------------------------------

describe('the wiring that runs this file in CI', () => {
	const STEP = 'Local entry-point check'
	const TEST = 'node --import tsx --test scripts/__tests__/check-local-entry.test.ts'

	/** Everything from the named step's `run:` to the next step at its level. */
	function stepRunBody(workflow) {
		const text = readFileSync(join(repoRoot, '.github', 'workflows', workflow), 'utf8')
		const marker = `- name: ${STEP}`
		const start = text.indexOf(marker)
		assert.notEqual(start, -1, `${workflow} no longer has a step named \`${STEP}\` — this test is stale`)

		// The indentation of the step, so the slice stops at the next step and a
		// neighbouring step's `run:` cannot stand in for this one's.
		const indent = text.slice(text.lastIndexOf('\n', start) + 1, start)
		const rest = text.slice(start + marker.length)
		const next = rest.search(new RegExp(`^${indent}- `, 'm'))
		return next === -1 ? rest : rest.slice(0, next)
	}

	for (const workflow of ['ci.yml', 'release.yml']) {
		test(`${workflow} names this file, which no package runs`, () => {
			const body = stepRunBody(workflow)
			assert.ok(
				body.includes(TEST),
				`the \`${STEP}\` step in ${workflow} no longer names this file, and \`pnpm -r test\` cannot reach scripts/:\n${body}`,
			)
		})
	}
})
