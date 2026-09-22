#!/usr/bin/env node
/**
 * The two paths onto `main` apply the same standard.
 *
 * ## The gap this exists for
 *
 * A change reaches `main` two ways. Through a pull request, where `ci.yml`'s
 * `Build & Test` job runs every gate; or by a direct push, where `ci.yml` does
 * not run that job at all and `release.yml` validates inline before publishing.
 * Its own comment says so: "Direct-to-main pushes are validated by release.yml's
 * own inline validation before publish."
 *
 * That inline validation ran five of the nineteen. Fifteen gates applied to
 * branches and to nothing else, and a push straight to `main` was green under a
 * standard nobody had written down. It surfaced when a documentation page went
 * stale on `main` inside a commit that reported success — the docs job simply
 * never ran on that path.
 *
 * Adding the missing steps fixes it once. This check is what stops it
 * happening again: two hand-maintained lists of the same thing drift, and every
 * other instance of that shape in this repository is now derived or compared.
 *
 * ## What it does NOT require
 *
 * Parity of the whole job. Three gates cost minutes rather than seconds and
 * belong to the pull-request path only, and pretending otherwise would make
 * every push to `main` pay for them. They are exempt BY NAME below, with the
 * reason, because an exemption a reader can see is a decision and a silent
 * difference is a bug.
 *
 * ## The skip, and why it is checked here
 *
 * `release.yml` skips its validation gates when `ci.yml` already validated the
 * exact tree being pushed (`.github/scripts/find-validated-tree.mjs`). That
 * skip is a claim that CI ran THESE gates on THESE bytes, and a condition is
 * the easiest place for a gate to go quiet: `if: false` keeps the step's name,
 * so a name comparison alone would stay green over a gate that never runs. So
 * the conditions are compared too:
 *
 *   - a release.yml gate carries no `if:` or exactly the skip guard;
 *   - a step carrying the skip guard is a gate `ci.yml` runs — a gate may be
 *     skipped on the strength of a CI run only if that CI run executes it;
 *   - Install, Build and the pre-publish consumer install check never carry
 *     it, because publishing needs `dist` and that check measures what ships;
 *   - the step that produces the skip exists, has no condition of its own, and
 *     comes before every step it guards;
 *   - a `ci.yml` gate carries no `if:` or exactly `matrix.gates`, and some
 *     matrix entry sets `gates: true`, so the run the skip trusts ran it;
 *   - no gate, on either path, and no job running one carries
 *     `continue-on-error` (other than a literal `false`): on ci.yml it lets a
 *     gate fail under a successful run, which the validated-tree record then
 *     vouches for; on release.yml it lets a failing gate step aside for publish.
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..'))

/**
 * Gates the pull-request path runs and the direct-push path deliberately does
 * not, each with the reason it is worth skipping there.
 *
 * Cost is the only admissible reason. "It rarely fails" is not one: a gate that
 * rarely fails is exactly the one nobody notices the absence of.
 */
const DIRECT_PUSH_EXEMPT = new Map([
	['Evals', 'runs the eval suites end to end — minutes, and every push would pay'],
	['SDK coverage (produce summary)', 'instruments the whole SDK suite; the floor gate below needs it'],
	['SDK coverage floor gate', 'reads the summary the step above produces, so it goes with it'],
	['Process-level regression tests', 'spawns real processes one at a time, deliberately unparallelised'],
	['Pre-publish consumer install check', 'already runs in release.yml, gated to the version commit'],
])

/** Steps that are setup rather than a gate. */
const NOT_A_GATE = /^(Run |Install$|Build the packages|Backfill |Create Release|Record |Upload )/

/** The release.yml step that decides whether CI already validated this tree. */
const SKIP_STEP_ID = 'revalidation'
/** The one condition a release.yml gate may carry. */
const SKIP_GUARD = `steps.${SKIP_STEP_ID}.outputs.skip != 'true'`
/** A release.yml step whose condition mentions the skip at all, well-formed or not. */
const isGuarded = (step) => step.if?.includes(`steps.${SKIP_STEP_ID}.outputs.skip`) ?? false
/** release.yml steps that must run whatever the skip says. */
const ALWAYS_RUNS = new Set(['Install', 'Build', 'Pre-publish consumer install check', 'Create Release Pull Request or Publish'])
/** The one condition a ci.yml gate may carry. */
const CI_GATE_CONDITION = 'matrix.gates'

/** `${{ x }}`, `"x"` and `'x'` all read as `x`, whitespace collapsed. */
function normaliseCondition(raw) {
	let value = raw.trim()
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'") && value.length > 1 && !value.slice(1, -1).includes("'"))) {
		value = value.slice(1, -1).trim()
	}
	const wrapped = value.match(/^\$\{\{([\s\S]*)\}\}$/)
	if (wrapped) value = wrapped[1].trim()
	return value.replace(/\s+/g, ' ')
}

/**
 * Every named step in a workflow, in order, with its `if:`, `id:`,
 * `continue-on-error:` and the job it belongs to. A step block runs from its
 * `- name:` line to the next line at the same indentation that starts a list
 * item, or to the first non-blank line indented less.
 */
function steps(file) {
	const lines = readFileSync(join(root, '.github', 'workflows', file), 'utf8').split('\n')
	const found = []
	let job
	for (let i = 0; i < lines.length; i += 1) {
		const jobHead = lines[i].match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
		if (jobHead) job = jobHead[1]
		const head = lines[i].match(/^(\s+)- name: (.+)$/)
		if (!head) continue
		const indent = head[1]
		const step = { name: head[2].trim(), if: undefined, id: undefined, continueOnError: undefined, job, index: found.length }
		for (let j = i + 1; j < lines.length; j += 1) {
			const line = lines[j]
			if (line.trim() === '' || line.trim().startsWith('#')) continue
			const lineIndent = line.match(/^(\s*)/)[1].length
			if (lineIndent < indent.length + 2) break
			const key = line.match(new RegExp(`^${indent}  (if|id|continue-on-error): (.+)$`))
			if (!key) continue
			if (key[1] === 'if') step.if = normaliseCondition(key[2])
			else if (key[1] === 'id') step.id = key[2].trim()
			else step.continueOnError = normaliseCondition(key[2])
		}
		found.push(step)
	}
	return found
}

/**
 * `continue-on-error:` set directly on each job, keyed by job id. Job-level
 * keys sit at four spaces under a two-space job id, below the top-level
 * `jobs:`.
 */
function jobContinueOnError(file) {
	const lines = readFileSync(join(root, '.github', 'workflows', file), 'utf8').split('\n')
	const found = new Map()
	let inJobs = false
	let job
	for (const line of lines) {
		if (/^\S/.test(line)) {
			inJobs = /^jobs:\s*$/.test(line)
			job = undefined
			continue
		}
		if (!inJobs) continue
		const jobHead = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
		if (jobHead) {
			job = jobHead[1]
			continue
		}
		const key = job && line.match(/^ {4}continue-on-error: (.+)$/)
		if (key) found.set(job, normaliseCondition(key[1]))
	}
	return found
}

/**
 * `continue-on-error` turns a failing step green, and a failing step in a job
 * green too. Only a literal `false` — the default spelled out — leaves a gate
 * able to fail; an expression may evaluate to true, so it is refused like `true`.
 */
function mayContinueOnError(value) {
	return value !== undefined && value !== 'false'
}

const ciText = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
const ciSteps = steps('ci.yml').filter((step) => !NOT_A_GATE.test(step.name))
const ci = ciSteps.map((step) => step.name)
const releaseSteps = steps('release.yml')
const release = new Set(releaseSteps.map((step) => step.name))

// `ci.yml` names it `Type check` and `release.yml` names it `Typecheck`. The
// same command either way; recorded here rather than renamed, because renaming
// a step breaks whatever required-check configuration names it.
const ALIASES = new Map([['Type check', 'Typecheck']])
const REVERSE_ALIASES = new Map([...ALIASES].map(([ciName, releaseName]) => [releaseName, ciName]))

const problems = []
let compared = 0

for (const name of ci) {
	compared += 1
	if (release.has(name) || release.has(ALIASES.get(name) ?? '')) continue
	if (DIRECT_PUSH_EXEMPT.has(name)) continue
	problems.push(
		`"${name}" runs on the pull-request path and not on the direct-push path.`,
		'    A push straight to `main` would be green without it. Add the step to',
		'    .github/workflows/release.yml, or exempt it by name in this file with',
		'    the reason — an exemption a reader can see is a decision; a difference',
		'    nobody compares is a bug.',
	)
}

// An exemption for a step that no longer exists is a stale note that reads as a
// live decision, and it hides the next real one behind an entry nobody rechecks.
for (const name of DIRECT_PUSH_EXEMPT.keys()) {
	if (!ci.includes(name) && !release.has(name)) {
		problems.push(
			`"${name}" is exempted here but appears in neither workflow.`,
			'    Remove the exemption: it documents a decision about a step that is gone.',
		)
	}
}

// A ci.yml gate that a condition can switch off is a gate the skip would trust
// without it having run.
for (const step of ciSteps) {
	if (step.if === undefined || step.if === CI_GATE_CONDITION) continue
	problems.push(
		`"${step.name}" in ci.yml runs under \`if: ${step.if}\`.`,
		`    A ci.yml gate carries no condition or exactly \`${CI_GATE_CONDITION}\`: release.yml skips`,
		'    its own gates on the strength of this run, so a gate this run can skip is',
		'    one that would run on neither path.',
	)
}
if (ciSteps.some((step) => step.if === CI_GATE_CONDITION) && !/^\s+gates: true\s*$/m.test(ciText)) {
	problems.push(
		`ci.yml gates run under \`if: ${CI_GATE_CONDITION}\` and no matrix entry sets \`gates: true\`.`,
		'    Those gates run on no leg, and a skipped step is green.',
	)
}

// A gate that cannot fail is a gate that did not run, as far as anything
// downstream can tell. On ci.yml, `continue-on-error` lets a gate fail while
// the job, and so the run, concludes success; `validated-tree` then records
// the tree and release.yml skips that gate too, so the failure reaches publish
// with no failing step on either path. On release.yml it lets a failing gate
// step aside for the publish step. Evals once carried it (see ci.yml).
const ciGateNames = new Set(ci)
const ciJobs = jobContinueOnError('ci.yml')
const releaseJobs = jobContinueOnError('release.yml')
for (const step of ciSteps) {
	if (!mayContinueOnError(step.continueOnError)) continue
	problems.push(
		`"${step.name}" in ci.yml carries \`continue-on-error: ${step.continueOnError}\`.`,
		'    A gate that may fail while its job succeeds is one the validated-tree record',
		'    vouches for without it having passed, and release.yml then skips it as well.',
	)
}
for (const job of new Set(ciSteps.map((step) => step.job))) {
	if (!mayContinueOnError(ciJobs.get(job))) continue
	problems.push(
		`The ci.yml job \`${job}\` carries \`continue-on-error: ${ciJobs.get(job)}\`, and it runs gates.`,
		'    A failing job under it leaves the run green, so the validated-tree record and',
		'    the skip in release.yml would both trust gates that failed.',
	)
}
const releaseChecked = releaseSteps.filter((step) => {
	const ciName = REVERSE_ALIASES.get(step.name) ?? step.name
	return ALWAYS_RUNS.has(step.name) || isGuarded(step) || ciGateNames.has(ciName) || step.id === SKIP_STEP_ID
})
for (const step of releaseChecked) {
	if (!mayContinueOnError(step.continueOnError)) continue
	problems.push(
		`"${step.name}" in release.yml carries \`continue-on-error: ${step.continueOnError}\`.`,
		'    A failing gate would step aside for the publish step. Drop it: a gate that',
		'    cannot stop the release is not one.',
	)
}
for (const job of new Set(releaseChecked.map((step) => step.job))) {
	if (!mayContinueOnError(releaseJobs.get(job))) continue
	problems.push(
		`The release.yml job \`${job}\` carries \`continue-on-error: ${releaseJobs.get(job)}\`, and it runs gates.`,
		'    It would report a failed validation as a green release run.',
	)
}

const skipStep = releaseSteps.find((step) => step.id === SKIP_STEP_ID)
for (const step of releaseSteps) {
	const guarded = isGuarded(step)
	const ciName = REVERSE_ALIASES.get(step.name) ?? step.name
	const isGate = ciGateNames.has(ciName) && !DIRECT_PUSH_EXEMPT.has(ciName)

	if (ALWAYS_RUNS.has(step.name)) {
		if (guarded) {
			problems.push(
				`"${step.name}" in release.yml is skipped when CI already validated the tree.`,
				'    It must always run: publishing needs the build, and the pre-publish check',
				'    measures the packages that actually ship, which no earlier run has seen.',
			)
		}
		continue
	}

	if (guarded && step.if !== SKIP_GUARD) {
		problems.push(
			`"${step.name}" in release.yml runs under \`if: ${step.if}\`.`,
			`    The skip guard is exactly \`${SKIP_GUARD}\`; any other spelling is a`,
			'    condition this check cannot read, and a gate it cannot read is one that may never run.',
		)
		continue
	}

	if (guarded && !ciGateNames.has(ciName)) {
		problems.push(
			`"${step.name}" in release.yml is skipped when CI validated the tree, and ci.yml has no such gate.`,
			'    The skip means "CI already ran this on these bytes". A step CI does not run',
			'    would then run on neither path. Add it to ci.yml or drop its guard.',
		)
		continue
	}

	if (guarded && DIRECT_PUSH_EXEMPT.has(ciName)) {
		problems.push(
			`"${step.name}" is exempt from the direct-push path and also carries the skip guard.`,
			'    An exempt step does not run on that path at all; guarding it is a contradiction.',
		)
		continue
	}

	if (isGate && step.if !== undefined && step.if !== SKIP_GUARD) {
		problems.push(
			`"${step.name}" in release.yml runs under \`if: ${step.if}\`.`,
			`    A gate carries no condition or exactly \`${SKIP_GUARD}\`. Any other`,
			'    condition keeps the name this check compares and can drop the gate.',
		)
		continue
	}

	if (guarded) {
		if (!skipStep) {
			problems.push(
				`"${step.name}" in release.yml is guarded by \`steps.${SKIP_STEP_ID}\`, and no step has \`id: ${SKIP_STEP_ID}\`.`,
			)
		} else if (skipStep.index > step.index) {
			problems.push(`"${step.name}" in release.yml is guarded by a skip decided only after it runs.`)
		}
	}
}
if (skipStep && skipStep.if !== undefined) {
	problems.push(
		`"${skipStep.name}" (id: ${SKIP_STEP_ID}) runs under \`if: ${skipStep.if}\`.`,
		'    The step that decides the skip carries no condition: it is the one step whose',
		'    running is what every guarded gate depends on.',
	)
}

if (compared === 0) {
	problems.push(
		'workflow-parity gate compared 0 steps.',
		'    Either ci.yml lost its steps or the parser stopped matching them;',
		'    reporting success over an empty comparison would make this decorative.',
	)
}

if (problems.length > 0) {
	console.log(`✗ WORKFLOW GATE PARITY — ${problems.length} line(s):`)
	for (const line of problems) console.log(`  ${line}`)
	process.exit(1)
}

const guardedCount = releaseSteps.filter((step) => step.if === SKIP_GUARD).length
console.log(
	`✓ workflow gates agree — ${compared} pull-request gate(s), ${DIRECT_PUSH_EXEMPT.size} exempt from the direct-push path by name, ${guardedCount} skipped on a tree CI already validated`,
)
