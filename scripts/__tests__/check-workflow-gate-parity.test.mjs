/**
 * `.github/scripts/check-workflow-gate-parity.mjs` fails when a gate is on one
 * path onto `main` and not the other — by name, and now by condition, because
 * release.yml skips its gates when CI already validated the tree and a
 * condition is where a gate goes quiet while keeping its name.
 *
 * `scripts/__tests__/` belongs to no package, so `pnpm -r test` cannot reach
 * this file; both workflows run it in the step it proves. By hand:
 *
 *   node --test scripts/__tests__/check-workflow-gate-parity.test.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, '.github', 'scripts', 'check-workflow-gate-parity.mjs')
const GUARD = "steps.revalidation.outputs.skip != 'true'"

const EXEMPT = ['Evals', 'SDK coverage (produce summary)', 'SDK coverage floor gate', 'Process-level regression tests']

function workflow(stepList, { preamble = '', jobKeys = '', trailer = '' } = {}) {
	const body = stepList
		.map((step) => {
			const lines = [`      - name: ${step.name}`]
			if (step.id) lines.push(`        id: ${step.id}`)
			if (step.if) lines.push(`        if: ${step.if}`)
			if (step.continueOnError) lines.push(`        continue-on-error: ${step.continueOnError}`)
			lines.push(`        run: echo ${JSON.stringify(step.name)}`)
			return lines.join('\n')
		})
		.join('\n\n')
	return `name: fixture\njobs:\n  check:\n    strategy:\n      matrix:\n        include:\n          - node-version: 24\n${preamble}${jobKeys}    steps:\n${body}\n${trailer}`
}

function ciSteps(overrides = {}) {
	return [
		{ name: 'Install' },
		{ name: 'Lint', if: overrides.Lint },
		{ name: 'Type check' },
		{ name: 'Build' },
		{ name: 'Docs OKF gate', if: 'matrix.gates' },
		...EXEMPT.map((name) => ({ name })),
		{ name: 'Pre-publish consumer install check', if: 'matrix.gates' },
		{ name: 'Record the tree the gates ran on' },
		{ name: 'Upload the validated-tree record' },
	]
}

function releaseSteps(overrides = {}) {
	const guardOf = (name) => (name in overrides ? overrides[name] : GUARD)
	return [
		{ name: 'Was this tree already validated by CI', id: 'revalidation', if: overrides.__skipIf },
		{ name: 'Install', if: overrides.Install },
		{ name: 'Lint', if: guardOf('Lint') },
		{ name: 'Typecheck', if: guardOf('Typecheck') },
		{ name: 'Build', if: overrides.Build },
		{ name: 'Docs OKF gate', if: guardOf('Docs OKF gate') },
		{
			name: 'Pre-publish consumer install check',
			if: overrides.prePublish ?? `"\${{ startsWith(github.event.head_commit.message, 'chore(release): version packages') }}"`,
		},
		{ name: 'Create Release Pull Request or Publish', id: 'changesets' },
	]
}

const RECORD_IF = "${{ success() && (github.event_name == 'pull_request' || github.event_name == 'merge_group') }}"
const RECORD_JOB = `  validated-tree:\n    name: Record the validated tree\n    needs: [check]\n    if: ${RECORD_IF}\n    runs-on: ubuntu-latest\n`

function check({ ci = ciSteps(), release = releaseSteps(), gatesLeg = true, ciJobKeys = '', releaseJobKeys = '', recordJob = RECORD_JOB } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'namzu-parity-'))
	try {
		mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
		writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), workflow(ci, { preamble: gatesLeg ? '            gates: true\n' : '', jobKeys: ciJobKeys, trailer: recordJob }))
		writeFileSync(join(root, '.github', 'workflows', 'release.yml'), workflow(release, { jobKeys: releaseJobKeys }))
		const result = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' })
		return { status: result.status, out: result.stdout + result.stderr }
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

describe('check-workflow-gate-parity', () => {
	it('passes on this repository', () => {
		const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
		assert.equal(result.status, 0, result.stdout + result.stderr)
		assert.match(result.stdout, /skipped on a tree CI already validated/)
	})

	it('passes on a fixture where every gate is guarded by the skip', () => {
		const { status, out } = check()
		assert.equal(status, 0, out)
		assert.match(out, /3 skipped on a tree CI already validated/)
	})

	it('passes when gates carry no condition at all', () => {
		const { status, out } = check({ release: releaseSteps({ Lint: undefined, Typecheck: undefined, 'Docs OKF gate': undefined }) })
		assert.equal(status, 0, out)
	})

	it('reads the guard wrapped in ${{ }} and quoted', () => {
		const { status, out } = check({ release: releaseSteps({ Lint: `"\${{ ${GUARD} }}"` }) })
		assert.equal(status, 0, out)
	})

	it('fails when a ci.yml gate is missing from release.yml', () => {
		const release = releaseSteps().filter((step) => step.name !== 'Docs OKF gate')
		const { status, out } = check({ release })
		assert.equal(status, 1)
		assert.match(out, /"Docs OKF gate" runs on the pull-request path and not on the direct-push path/)
	})

	it('fails when a release.yml gate carries a condition other than the guard', () => {
		const { status, out } = check({ release: releaseSteps({ Lint: 'false' }) })
		assert.equal(status, 1)
		assert.match(out, /"Lint" in release\.yml runs under `if: false`/)
	})

	it('fails on a misspelled guard', () => {
		const { status, out } = check({ release: releaseSteps({ Lint: "steps.revalidation.outputs.skip == 'false'" }) })
		assert.equal(status, 1)
		assert.match(out, /The skip guard is exactly/)
	})

	it('fails when a guarded release.yml step is not a ci.yml gate', () => {
		const release = releaseSteps()
		release.splice(3, 0, { name: 'A gate only release runs', if: GUARD })
		const { status, out } = check({ release })
		assert.equal(status, 1)
		assert.match(out, /"A gate only release runs" in release\.yml is skipped when CI validated the tree, and ci\.yml has no such gate/)
	})

	it('allows an unguarded release.yml step ci.yml does not run', () => {
		const release = releaseSteps()
		release.splice(3, 0, { name: 'A gate only release runs' })
		const { status, out } = check({ release })
		assert.equal(status, 0, out)
	})

	it('fails when Build carries the skip guard', () => {
		const { status, out } = check({ release: releaseSteps({ Build: GUARD }) })
		assert.equal(status, 1)
		assert.match(out, /"Build" in release\.yml is skipped when CI already validated the tree/)
	})

	it('fails when Install carries the skip guard', () => {
		const { status, out } = check({ release: releaseSteps({ Install: GUARD }) })
		assert.equal(status, 1)
		assert.match(out, /"Install" in release\.yml is skipped/)
	})

	it('fails when the pre-publish consumer install check carries the skip guard', () => {
		const prePublish = `startsWith(github.event.head_commit.message, 'chore(release): version packages') && ${GUARD}`
		const { status, out } = check({ release: releaseSteps({ prePublish }) })
		assert.equal(status, 1)
		assert.match(out, /"Pre-publish consumer install check" in release\.yml is skipped/)
	})

	it('fails when no step produces the skip', () => {
		const release = releaseSteps().filter((step) => step.id !== 'revalidation')
		const { status, out } = check({ release })
		assert.equal(status, 1)
		assert.match(out, /no step has `id: revalidation`/)
	})

	it('fails when the skip is decided after a step it guards', () => {
		const release = releaseSteps()
		const [decider] = release.splice(0, 1)
		release.push(decider)
		const { status, out } = check({ release })
		assert.equal(status, 1)
		assert.match(out, /guarded by a skip decided only after it runs/)
	})

	it('fails when the step deciding the skip is itself conditional', () => {
		const { status, out } = check({ release: releaseSteps({ __skipIf: "github.actor == 'someone'" }) })
		assert.equal(status, 1)
		assert.match(out, /\(id: revalidation\) runs under/)
	})

	it('fails when a ci.yml gate can be switched off by a condition', () => {
		const { status, out } = check({ ci: ciSteps({ Lint: 'false' }) })
		assert.equal(status, 1)
		assert.match(out, /"Lint" in ci\.yml runs under `if: false`/)
	})

	it('fails when ci.yml gates wait on matrix.gates and no leg sets it', () => {
		const { status, out } = check({ gatesLeg: false })
		assert.equal(status, 1)
		assert.match(out, /job `check` has gates under `if: matrix\.gates` and no entry in its own `strategy\.matrix\.include` sets `gates: true`/)
	})

	// A gate under continue-on-error fails while its job, and the run, succeed:
	// validated-tree records the tree and release.yml skips the gate as well.
	const withContinue = (list, name, value = 'true') => list.map((step) => (step.name === name ? { ...step, continueOnError: value } : step))

	it('fails when a ci.yml gate carries continue-on-error', () => {
		const { status, out } = check({ ci: withContinue(ciSteps(), 'Evals') })
		assert.equal(status, 1)
		assert.match(out, /"Evals" in ci\.yml carries `continue-on-error: true`/)
	})

	it('fails when a matrix.gates ci.yml gate carries continue-on-error as an expression', () => {
		const { status, out } = check({ ci: withContinue(ciSteps(), 'Docs OKF gate', '${{ matrix.gates }}') })
		assert.equal(status, 1)
		assert.match(out, /"Docs OKF gate" in ci\.yml carries `continue-on-error: matrix\.gates`/)
	})

	it('accepts continue-on-error: false spelled out', () => {
		const { status, out } = check({ ci: withContinue(ciSteps(), 'Lint', 'false'), release: withContinue(releaseSteps(), 'Lint', 'false') })
		assert.equal(status, 0, out)
	})

	it('fails when a ci.yml job running gates carries continue-on-error', () => {
		const { status, out } = check({ ciJobKeys: '    continue-on-error: true\n' })
		assert.equal(status, 1)
		assert.match(out, /The ci\.yml job `check` carries `continue-on-error: true`, and it runs gates/)
	})

	it('fails when a guarded release.yml gate carries continue-on-error', () => {
		const { status, out } = check({ release: withContinue(releaseSteps(), 'Lint') })
		assert.equal(status, 1)
		assert.match(out, /"Lint" in release\.yml carries `continue-on-error: true`/)
	})

	it('fails when an unguarded release.yml gate carries continue-on-error', () => {
		const release = withContinue(releaseSteps({ Typecheck: undefined }), 'Typecheck')
		const { status, out } = check({ release })
		assert.equal(status, 1)
		assert.match(out, /"Typecheck" in release\.yml carries `continue-on-error: true`/)
	})

	it('fails when Build in release.yml carries continue-on-error', () => {
		const { status, out } = check({ release: withContinue(releaseSteps(), 'Build') })
		assert.equal(status, 1)
		assert.match(out, /"Build" in release\.yml carries `continue-on-error: true`/)
	})

	it('fails when the release job carries continue-on-error', () => {
		const { status, out } = check({ releaseJobKeys: '    continue-on-error: ${{ true }}\n' })
		assert.equal(status, 1)
		assert.match(out, /The release\.yml job `check` carries `continue-on-error: true`, and it runs gates/)
	})

	it('accepts needs written as a bare job id', () => {
		const { status, out } = check({ recordJob: RECORD_JOB.replace('needs: [check]', 'needs: check') })
		assert.equal(status, 0, out)
	})

	// A block sequence is ordinary YAML, and a regex over the whole file for it
	// backtracks until the job times out. These hold the parse to the job's lines.
	it('reads needs written as a block sequence, with steps after it', () => {
		const blockNeeds = `  validated-tree:\n    name: Record the validated tree\n    needs:\n      - check\n    if: ${RECORD_IF}\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v5\n      - uses: actions/upload-artifact@v4\n`
		const started = Date.now()
		const { status, out } = check({ recordJob: blockNeeds })
		assert.equal(status, 0, out)
		assert.ok(Date.now() - started < 10_000, 'the check must answer in seconds, not backtrack')
	})

	it('fails when a block-sequence needs omits a job that runs gates', () => {
		const blockNeeds = `  validated-tree:\n    name: Record the validated tree\n    needs:\n      - docs\n    if: ${RECORD_IF}\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v5\n      - uses: actions/upload-artifact@v4\n`
		const { status, out } = check({ recordJob: blockNeeds })
		assert.equal(status, 1)
		assert.match(out, /The ci\.yml job `check` runs gates, and `validated-tree` does not list it in `needs`/)
	})

	it('fails when validated-tree does not wait on a job that runs gates', () => {
		const { status, out } = check({ recordJob: RECORD_JOB.replace('needs: [check]', 'needs: [docs]') })
		assert.equal(status, 1)
		assert.match(out, /The ci\.yml job `check` runs gates, and `validated-tree` does not list it in `needs`/)
	})

	it('fails when validated-tree has no needs at all', () => {
		const { status, out } = check({ recordJob: RECORD_JOB.replace('    needs: [check]\n', '') })
		assert.equal(status, 1)
		assert.match(out, /does not list it in `needs`/)
	})

	it('fails when ci.yml has no validated-tree job', () => {
		const { status, out } = check({ recordJob: '' })
		assert.equal(status, 1)
		assert.match(out, /ci\.yml has no `validated-tree` job/)
	})

	// `matrix.gates` is read in the step's OWN job: in a job with no matrix it
	// is empty, the step is skipped, the job succeeds and the record is written.
	const docsJob = (jobKeys = '') =>
		`  docs:\n    runs-on: ubuntu-latest\n${jobKeys}    steps:\n      - name: Docs fence gate\n        if: matrix.gates\n        run: echo fence\n`

	it('fails when matrix.gates guards a gate in a job with no matrix, though another job has a gates leg', () => {
		const { status, out } = check({ recordJob: docsJob() + RECORD_JOB.replace('needs: [check]', 'needs: [check, docs]') })
		assert.equal(status, 1)
		assert.match(out, /ci\.yml job `docs` has gates under `if: matrix\.gates` and no entry in its own `strategy\.matrix\.include` sets `gates: true`/)
		assert.doesNotMatch(out, /job `check` has gates under/)
	})

	it('fails when the only gates leg sits under exclude', () => {
		const jobKeys = '    strategy:\n      matrix:\n        include:\n          - node-version: 24\n        exclude:\n          - node-version: 24\n            gates: true\n'
		const { status, out } = check({ recordJob: docsJob(jobKeys) + RECORD_JOB.replace('needs: [check]', 'needs: [check, docs]') })
		assert.equal(status, 1)
		assert.match(out, /ci\.yml job `docs` has gates under `if: matrix\.gates`/)
	})

	it('accepts matrix.gates in a job whose own include sets gates: true', () => {
		const jobKeys = '    strategy:\n      matrix:\n        include:\n          - node-version: 24\n            gates: true\n'
		const { out } = check({ recordJob: docsJob(jobKeys) + RECORD_JOB.replace('needs: [check]', 'needs: [check, docs]') })
		assert.doesNotMatch(out, /has gates under `if: matrix\.gates`/)
	})

	// A job skipped by its own condition does not fail the run.
	it('fails when a ci.yml job running gates carries a job-level if', () => {
		const { status, out } = check({ ciJobKeys: "    if: github.event_name == 'merge_group'\n" })
		assert.equal(status, 1)
		assert.match(out, /The ci\.yml job `check` runs gates under a job-level `if: github\.event_name == 'merge_group'`/)
	})

	it('fails when validated-tree runs under !failure() rather than success()', () => {
		const recordJob = RECORD_JOB.replace(RECORD_IF, "${{ !failure() && !cancelled() && (github.event_name == 'pull_request' || github.event_name == 'merge_group') }}")
		const { status, out } = check({ recordJob })
		assert.equal(status, 1)
		assert.match(out, /`validated-tree` in ci\.yml runs under `if: !failure\(\)/)
	})

	it('fails when validated-tree has no if', () => {
		const { status, out } = check({ recordJob: RECORD_JOB.replace(`    if: ${RECORD_IF}\n`, '') })
		assert.equal(status, 1)
		assert.match(out, /`validated-tree` in ci\.yml runs under `if: \(none\)`/)
	})

	it('fails when validated-tree drops the event filter', () => {
		const { status, out } = check({ recordJob: RECORD_JOB.replace(RECORD_IF, 'success()') })
		assert.equal(status, 1)
		assert.match(out, /`validated-tree` in ci\.yml runs under `if: success\(\)`/)
	})

	it('still fails on an exemption for a step that is gone', () => {
		const ci = ciSteps().filter((step) => step.name !== 'Evals')
		const { status, out } = check({ ci })
		assert.equal(status, 1)
		assert.match(out, /"Evals" is exempted here but appears in neither workflow/)
	})
})
