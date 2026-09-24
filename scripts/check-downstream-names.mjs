#!/usr/bin/env node
/**
 * Refuse a downstream consumer's name in what a pull request carries (issue
 * #530): the text it brings outside the tree, and every commit it would land.
 *
 * `scripts/audit-external-names.mjs` refuses one anywhere in the checked-out
 * tree, and that is only part of what reaches `main`. This reads, from the
 * event that triggered the run:
 *
 *  - a pull request's title, body and head branch name;
 *  - for every commit between the base and the head: its message, the name
 *    and address of its author and of its committer, the lines it adds and the
 *    paths it adds or changes.
 *
 * ## Why every commit, and not the pull request's combined diff
 *
 * What lands depends on how the pull request is merged, and this repository
 * allows two ways:
 *
 *  - A squash merge writes one commit with the combined change, the title,
 *    and every commit message; and GitHub adds a `Co-authored-by: <name>
 *    <address>` trailer for each author of the pull request's commits. That is
 *    how names reached `main` before: from a PR description, and from work
 *    addresses in those trailers under messages that named no one.
 *  - A rebase merge lands each commit as it is, with its own tree, message and
 *    identities. A name one commit adds and a later one removes is on `main`
 *    for good, though the final tree, and so the combined diff and the tree
 *    audit, show nothing.
 *
 * And whatever the merge, `refs/pull/<n>/head` keeps every commit of a pull
 * request reachable on GitHub. So each commit is read on its own: the lines it
 * adds are the lines of each file it changes that none of its parents' copies
 * of that file has. By induction that covers every line of every tree the
 * pull request's commits carry that `main` did not already have, which is a
 * superset of the combined diff: a squash merge is covered too. A merge commit
 * inside the pull request adds only what differs from every parent — the text
 * its author wrote while resolving it — since the rest came from `main` or from
 * a commit this reads on its own.
 *
 * A line the pull request removes is not read, so deleting a name `main`
 * already carries is the fix. A name a commit of the pull request added is not
 * fixed by a later commit that removes it: that commit has to be rewritten
 * (`git rebase -i` and a force push), which is what the failure says.
 *
 * For a merge queue's `merge_group` event there is no title or body: the
 * commits between the queue's base and head are the ones about to land, and
 * they are read the same way.
 *
 *     node scripts/check-downstream-names.mjs --event "$GITHUB_EVENT_PATH"
 *
 * The list is the environment variable `NAMZU_DOWNSTREAM_NAMES`, which
 * `.github/workflows/pr-text.yml` fills from the repository secret of the same
 * name; no file of this repository holds it in any form. Without it, a run for
 * a pull request from a fork — which GitHub gives no secrets — skips with a
 * notice saying so, a local run given `--without-downstream-names` skips and
 * says so, and every other run fails with `NAMZU_DOWNSTREAM_NAMES is not set`.
 * `scripts/downstream-names.mjs` says why, and what an entry may say. Nothing
 * this prints repeats a name or any part of the variable's value.
 *
 * Exit codes: 0 nothing named, or the rule skipped as above; 1 a name found;
 * 2 the answer could not be established — no list, an entry the list cannot
 * use, an event this does not read, or commits git cannot find.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import {
	OPT_OUT_OPTION,
	REMEDY,
	excerpt,
	findingsIn,
	matcherSelfCheck,
	namesIn,
	parseNames,
	printable,
	resolveDownstreamNames,
} from './downstream-names.mjs'

/** The list. Empty until the environment is read. */
let names = parseNames('')

/**
 * Every line this prints, as `printable` allows: redacted whole, and withheld
 * if any entry's text would still show. A name can reach a message from
 * somewhere other than a finding, such as a path in an error.
 */
const say = (line = '') => console.log(printable(line, names))
const complain = (line = '') => console.error(printable(line, names))

function cannotEstablish(message) {
	complain(message)
	process.exit(2)
}

let options
try {
	options = parseArgs({
		options: { event: { type: 'string' }, [OPT_OUT_OPTION]: { type: 'boolean' } },
	}).values
} catch (error) {
	cannotEstablish(`check-downstream-names: ${error.message}`)
}
if (options.event === undefined)
	cannotEstablish('check-downstream-names: --event <path> is required')

let resolved
try {
	resolved = resolveDownstreamNames({ optOut: options[OPT_OUT_OPTION] === true })
} catch (error) {
	cannotEstablish(`the downstream-name list could not be read: ${error.message}`)
}
if (resolved.fail !== undefined) cannotEstablish(resolved.fail)
if (resolved.skip !== undefined) {
	say(resolved.skip)
	process.exit(0)
}
names = resolved.list

const broken = matcherSelfCheck()
if (broken.length > 0) {
	cannotEstablish(
		`the downstream-name matcher disagrees with its own cases:\n\n${broken.map((line) => `  ${line}`).join('\n')}`,
	)
}

let payload
try {
	payload = JSON.parse(readFileSync(options.event, 'utf8'))
} catch (error) {
	cannotEstablish(`the event ${options.event} could not be read: ${error.message}`)
}

/** What the event gives this check to read: its texts and its commit range. */
function subjectOf(event) {
	const pr = event?.pull_request
	if (pr) {
		return {
			label: `pull request #${pr.number}`,
			texts: [
				['PR title', pr.title ?? ''],
				['PR body', pr.body ?? ''],
				['head branch', pr.head?.ref ?? ''],
			],
			base: pr.base?.sha,
			head: pr.head?.sha,
		}
	}
	const group = event?.merge_group
	if (group) {
		return { label: 'the merge group', texts: [], base: group.base_sha, head: group.head_sha }
	}
	return undefined
}

const subject = subjectOf(payload)
if (subject === undefined) {
	cannotEstablish(
		`the event ${options.event} is neither a pull request nor a merge group, so there is nothing here to read`,
	)
}

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/
for (const [end, sha] of [
	['base', subject.base],
	['head', subject.head],
]) {
	if (typeof sha !== 'string' || !OBJECT_ID.test(sha)) {
		cannotEstablish(`the event gives no ${end} commit for ${subject.label}`)
	}
}

/** Git's output as text, or as bytes when `input` is given for its standard input. */
function git(args, input) {
	try {
		return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
			...(input === undefined ? { encoding: 'utf8' } : { input: Buffer.from(input, 'utf8') }),
			maxBuffer: 1024 * 1024 * 1024,
			stdio: ['pipe', 'pipe', 'pipe'],
		})
	} catch (error) {
		const detail = String(error.stderr ?? error.message).trim()
		cannotEstablish(
			`git could not read ${subject.label} (${subject.base.slice(0, 12)}..${subject.head.slice(0, 12)}); a shallow checkout lacks the history this needs:\n  ${detail}`,
		)
	}
}

const hits = []

for (const [where, text] of subject.texts) {
	for (const hit of findingsIn(text, names)) {
		hits.push({ where: where === 'PR body' ? `${where}:${hit.line}` : where, text: hit.text })
	}
}

const range = `${subject.base}..${subject.head}`

// One record per commit: its id, its author, its committer, one to a line,
// then its raw message. Git keeps newlines out of a name and an address, so
// the first three lines are exactly those fields. `%an` and `%cn` are the
// identities as recorded, not as a `.mailmap` would rewrite them.
const log = git(['log', '-z', '--format=%H%n%an <%ae>%n%cn <%ce>%n%B', range, '--'])
const records = log.split('\0').filter((record) => record.trim() !== '')
for (const record of records) {
	const [sha, author, committer, ...message] = record.split('\n')
	const commit = `commit ${sha.slice(0, 12)}`
	for (const [role, identity] of [
		['author', author],
		['committer', committer],
	]) {
		if (namesIn(identity, names)) {
			hits.push({ where: `${commit} ${role}`, text: excerpt(identity, names) })
		}
	}
	for (const hit of findingsIn(message.join('\n'), names)) {
		hits.push({ where: `${commit}:${hit.line}`, text: hit.text })
	}
}

const NO_OBJECT = /^0+$/
const GITLINK = '160000'

/**
 * The files `commit` changes relative to EVERY one of its parents, each with
 * its new blob and its parents' blobs. A file that equals one parent's copy
 * adds nothing that parent did not have. A root commit is read against
 * nothing: every file it has is new.
 */
function changedFiles(commit, parents) {
	const diffs = (parents.length === 0 ? [undefined] : parents).map((parent) => {
		const args = [
			'diff-tree',
			'-r',
			'-z',
			'--no-renames',
			'--no-abbrev',
			'--no-commit-id',
			'--root',
		]
		const raw = git(parent === undefined ? [...args, commit] : [...args, parent, commit])
		// `:<old mode> <new mode> <old blob> <new blob> <status>`, then the path.
		const fields = raw.split('\0')
		const files = new Map()
		for (let index = 0; index + 1 < fields.length; index += 2) {
			const [oldMode, newMode, oldBlob, newBlob] = fields[index].slice(1).split(' ')
			files.set(fields[index + 1], { oldMode, newMode, oldBlob, newBlob })
		}
		return files
	})
	const changed = []
	for (const [path, first] of diffs[0]) {
		const all = diffs.map((files) => files.get(path))
		if (all.some((change) => change === undefined)) continue
		if (NO_OBJECT.test(first.newBlob)) continue
		changed.push({
			path,
			blob: first.newMode === GITLINK ? undefined : first.newBlob,
			parentBlobs: all
				.filter((change) => change.oldMode !== GITLINK && !NO_OBJECT.test(change.oldBlob))
				.map((change) => change.oldBlob),
		})
	}
	return changed
}

/** The text of every blob asked for, by id, read in one `git cat-file --batch`. */
function blobTexts(ids) {
	const texts = new Map()
	if (ids.size === 0) return texts
	const output = git(['cat-file', '--batch'], `${[...ids].join('\n')}\n`)
	let at = 0
	while (at < output.length) {
		const headerEnd = output.indexOf(0x0a, at)
		const [id, type, size] = output.subarray(at, headerEnd).toString('utf8').split(' ')
		if (type === 'missing' || size === undefined) {
			cannotEstablish(`git has no object ${id} for ${subject.label}`)
		}
		const start = headerEnd + 1
		const end = start + Number(size)
		texts.set(id, output.subarray(start, end).toString('utf8'))
		at = end + 1
	}
	return texts
}

const commits = git(['rev-list', '--reverse', '--parents', range, '--'])
	.split('\n')
	.filter(Boolean)
	.map((line) => {
		const [sha, ...parents] = line.split(' ')
		return { sha, files: changedFiles(sha, parents) }
	})

const blobs = new Set()
for (const { files } of commits) {
	for (const file of files) {
		if (file.blob !== undefined) blobs.add(file.blob)
		for (const blob of file.parentBlobs) blobs.add(blob)
	}
}
const texts = blobTexts(blobs)

const pathsRead = new Set()
let added = 0
for (const { sha, files } of commits) {
	const commit = `commit ${sha.slice(0, 12)}`
	for (const { path, blob, parentBlobs } of files) {
		if (!pathsRead.has(path)) {
			pathsRead.add(path)
			if (namesIn(path, names))
				hits.push({ where: `${path} (${commit})`, text: '(the path itself)' })
		}
		const text = blob === undefined ? undefined : texts.get(blob)
		// A NUL byte means a binary file: an image has no prose to name anyone in.
		if (text === undefined || text.includes('\0')) continue
		const before = new Set(parentBlobs.flatMap((parent) => texts.get(parent).split('\n')))
		const lines = text.split('\n')
		// The empty string after a final newline is no line.
		if (text.endsWith('\n')) lines.pop()
		lines.forEach((line, index) => {
			if (before.has(line)) return
			added += 1
			for (const hit of findingsIn(line, names)) {
				hits.push({ where: `${path}:${index + 1} (${commit})`, text: hit.text })
			}
		})
	}
}

if (hits.length === 0) {
	const read = [
		...subject.texts.map(([where]) => where),
		`${commits.length} commit(s) (message, author, committer and added lines)`,
		`${pathsRead.size} path(s)`,
		`${added} added line(s)`,
	]
	say(`No downstream consumer name in ${subject.label}: ${read.join(', ')}.`)
	process.exit(0)
}

complain(`${hits.length} downstream-name reference(s) in ${subject.label}. ${REMEDY}:\n`)
for (const hit of hits) {
	complain(`  ${hit.where}  [downstream name]`)
	complain(`    ${hit.text}`)
}
complain(
	'\nA title, body or branch name is fixed by editing it, which runs this again. Anything a commit carries — its message, author, committer, or a line or path it adds — is fixed by rewriting that commit (`git rebase -i`; `git commit --amend --reset-author` for the author) and force-pushing: a later commit that removes the name leaves it in the one that added it, which a rebase merge lands as it is.',
)
process.exit(1)
