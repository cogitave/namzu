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
const NOT_A_GATE = /^(Run |Install$|Build the packages|Backfill |Create Release)/

function stepNames(file) {
	const text = readFileSync(join(root, '.github', 'workflows', file), 'utf8')
	return [...text.matchAll(/^\s+- name: (.+)$/gm)].map((m) => m[1].trim())
}

const ci = stepNames('ci.yml').filter((name) => !NOT_A_GATE.test(name))
const release = new Set(stepNames('release.yml'))

// `ci.yml` names it `Type check` and `release.yml` names it `Typecheck`. The
// same command either way; recorded here rather than renamed, because renaming
// a step breaks whatever required-check configuration names it.
const ALIASES = new Map([['Type check', 'Typecheck']])

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

console.log(
	`✓ workflow gates agree — ${compared} pull-request gate(s), ${DIRECT_PUSH_EXEMPT.size} exempt from the direct-push path by name`,
)
