#!/usr/bin/env node
/**
 * Does the pushed tree carry pending changesets, so that this push cannot publish?
 *
 * `changesets/action` decides from the checked-out tree alone: with at least one
 * pending changeset it versions and opens or updates the "version packages" pull
 * request and publishes nothing; with none it runs the publish script. A feature
 * merge that adds a `.changeset/<slug>.md` is therefore a push that publishes
 * nothing, and validating it inline measures a tree no registry will ever see
 * (the version PR that does ship gets its own CI run and, on merge, this
 * workflow with no pending changesets, which is a different decision).
 *
 * The listing mirrors `@changesets/read`: top-level entries of `.changeset/`
 * ending in `.md`, except `README.md`. Anything this script cannot establish
 * answers no — a git failure, an empty listing, a `.changeset/pre.json`
 * (pre-release mode changes what a changeset means, and a pre-release is
 * published), a non-regular `.md` entry — and the caller then falls through to
 * the validated-tree lookup and, failing that, every gate. Being wrong toward
 * "pending" would publish a tree nothing checked, so every doubt is "none".
 *
 * Usage (as release.yml runs it, ahead of find-validated-tree.mjs):
 *
 *   node .github/scripts/pending-changesets.mjs --tree "$(git rev-parse 'HEAD^{tree}')"
 *
 * Exits 0 only for a yes and, when `GITHUB_OUTPUT` is set, writes
 * `skip=true`, `reason=…` and `run_url=` there. Any other outcome exits 1 and
 * writes nothing, so the next step's `skip=false` stands.
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const CHANGESET_DIR = '.changeset'
const IGNORED = new Set(['README.md'])

/**
 * Parse `git ls-tree -z <tree> .changeset/` output (`<mode> <type> <sha>\t<path>`).
 * Returns `{ pending, reason }`; never throws on malformed input.
 */
export function decidePending(lsTreeOutput) {
	if (typeof lsTreeOutput !== 'string') return { pending: [], reason: 'no listing of the tree' }
	const names = []
	let preMode = false
	for (const entry of lsTreeOutput.split('\0')) {
		if (entry === '') continue
		const tab = entry.indexOf('\t')
		if (tab < 0) return { pending: [], reason: `unreadable tree entry ${JSON.stringify(entry)}` }
		const [mode, type] = entry.slice(0, tab).split(' ')
		const path = entry.slice(tab + 1)
		if (!path.startsWith(`${CHANGESET_DIR}/`)) {
			return { pending: [], reason: `unexpected tree entry ${JSON.stringify(path)}` }
		}
		const name = path.slice(CHANGESET_DIR.length + 1)
		if (name === 'pre.json') preMode = true
		if (!name.endsWith('.md') || IGNORED.has(name)) continue
		if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
			return { pending: [], reason: `${path} is not a regular file` }
		}
		names.push(name)
	}
	if (preMode) return { pending: [], reason: 'pre-release mode (.changeset/pre.json) is on' }
	if (names.length === 0) return { pending: [], reason: 'no pending changeset' }
	return { pending: names.sort(), reason: '' }
}

export function listChangesetDir(tree, run = execFileSync) {
	return run('git', ['ls-tree', '-z', tree, `${CHANGESET_DIR}/`], {
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024,
	})
}

export function decide(tree, run = execFileSync) {
	if (!/^[0-9a-f]{40,64}$/.test(tree ?? '')) return { skip: false, reason: 'no tree id given' }
	let out
	try {
		out = listChangesetDir(tree, run)
	} catch (error) {
		return {
			skip: false,
			reason: `could not read the tree: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
	const { pending, reason } = decidePending(out)
	if (pending.length === 0) return { skip: false, reason }
	const shown = pending.slice(0, 5).join(', ') + (pending.length > 5 ? `, +${pending.length - 5} more` : '')
	return {
		skip: true,
		reason: `the pushed tree carries ${pending.length} pending changeset(s) (${shown}), so the Changesets action only updates the version PR and publishes nothing`,
	}
}

function main() {
	const i = process.argv.indexOf('--tree')
	let result
	try {
		result = decide(i >= 0 ? process.argv[i + 1] : undefined)
	} catch (error) {
		result = { skip: false, reason: `the check failed: ${error instanceof Error ? error.message : String(error)}` }
	}
	if (!result.skip) {
		console.log(`✗ no publish-free push established: ${result.reason}`)
		process.exit(1)
	}
	console.log(`✓ this push cannot publish — the validation gates are skipped.`)
	console.log(`  ${result.reason}`)
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(
			process.env.GITHUB_OUTPUT,
			`skip=true\nreason=${result.reason.replace(/[\r\n]+/g, ' ')}\nrun_url=\npath=no-publish\n`,
		)
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
