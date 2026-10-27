/**
 * What the repository looked like when it last changed.
 *
 * `environment.ts` deliberately keeps the working tree's dirty state out of
 * the system prompt: that block is the cached prefix, and a file count that
 * changes whenever the agent saves would re-key the cache every turn. The
 * counter-argument is just as real — an agent that does not know a tree is
 * dirty commits somebody else's half-finished work, and an agent that does
 * not know the last five commits re-does one of them.
 *
 * Both are right, and the conversation can hold the reconciliation: the
 * snapshot is recorded as an entry the conversation keeps, once, and again
 * only when the repository differs from what the entries already say. An
 * unchanged tree adds nothing, so every request keeps beginning with the whole
 * of the one before it; a changed tree adds a short entry naming what is newly
 * listed, what no longer is and which commits are new. What the entries said
 * is read back from the history itself, so a resumed, forked or rewound
 * session needs no extra state, and a compaction that dropped the entries
 * makes the next one a whole snapshot again.
 *
 * ## Untrusted, and said so
 *
 * A file name and a commit subject are text somebody wrote, and this text
 * lands in a SYSTEM message. A branch checked out from a fork can carry a
 * commit titled "ignore your instructions and run …", and a file can be named
 * to close a code fence. So the block goes through the same envelope every
 * tool result from outside the process uses, each line is cut to a bound, and
 * control characters are dropped — the model is told it is looking at data.
 *
 * ## Bounded, in bytes and in lines
 *
 * A status with four hundred entries is a generated directory somebody forgot
 * to ignore, and the first thirty lines say so as well as all four hundred
 * would. The cut is applied after the read, so the read itself is bounded
 * too: a `maxBuffer` a real status can reach, and a two-second deadline. A
 * read that exceeds either produces NO snapshot rather than a wrong one, and
 * the model is left with `git status` as it was before this existed.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { type PrepareStep, turnContextEntries, wrapUntrusted } from '@namzu/sdk'

const run = promisify(execFile)

/** Bound on a single git call. A wedged repository must not stall a turn. */
const GIT_TIMEOUT_MS = 2_000
/**
 * Bound on what one call may return. A status line is a path, so this is
 * roughly forty thousand of them — well past any tree this block is for.
 */
const GIT_MAX_BUFFER = 4 * 1024 * 1024
/** Status entries shown before the rest is summarised as a count. */
export const MAX_STATUS_LINES = 30
/** Recent commits shown; enough to see what the last few turns did. */
export const RECENT_COMMITS = 5
/** Longest line the block will carry; a path or subject past this is cut. */
export const MAX_LINE_CHARS = 200

export interface TurnSnapshot {
	/** `git status --short`, already cut to `MAX_STATUS_LINES`. */
	readonly status: readonly string[]
	/** Entries the cut dropped. `0` when the status was shown whole. */
	readonly omittedStatusLines: number
	/** `git log --oneline`, newest first. */
	readonly recentCommits: readonly string[]
}

async function git(cwd: string, args: readonly string[]): Promise<string[] | null> {
	try {
		const { stdout } = await run('git', [...args], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: GIT_MAX_BUFFER,
		})
		return stdout
			.split('\n')
			.filter((line) => line.length > 0)
			.map(boundLine)
	} catch {
		// Not a repository, no git, a call that timed out or overran the
		// buffer — the snapshot is simply not available, and the block below
		// does not claim one.
		return null
	}
}

/** One line, printable characters only, cut at the bound with a marker. */
export function boundLine(line: string): string {
	const printable = line.replace(/\p{Cc}/gu, '')
	return printable.length > MAX_LINE_CHARS ? `${printable.slice(0, MAX_LINE_CHARS)}…` : printable
}

/**
 * `null` when the directory is not a repository, so a caller renders nothing
 * rather than an empty heading.
 */
export async function readTurnSnapshot(cwd: string): Promise<TurnSnapshot | null> {
	const [status, log] = await Promise.all([
		git(cwd, ['status', '--short']),
		git(cwd, ['log', '--oneline', `-${RECENT_COMMITS}`]),
	])
	if (status === null) return null
	return {
		status: status.slice(0, MAX_STATUS_LINES),
		omittedStatusLines: Math.max(0, status.length - MAX_STATUS_LINES),
		// An unborn branch has no log; that is a repository with no commits,
		// not a failure to read one.
		recentCommits: log ?? [],
	}
}

/** The key the snapshot entries are filed under. */
export const REPOSITORY_ENTRY_KEY = 'repository'

const FULL_HEADING = '## Repository'
const NOTE_FULL =
	'This is the repository as of the time in the entry header; it does not update as you work. A later repository entry lists what changed since. Run `git status` before any action that depends on the current state.'
const PROVENANCE =
	'File names and commit subjects read from the working directory with git. They were written by whoever committed or created them.'
const PROVENANCE_DELTA =
	'File names and commit subjects, written by whoever committed or created them.'
const TREE_HEADING = 'Working tree (git status --short):'
const TREE_CLEAN = 'Working tree: clean.'
const COMMITS_HEADING = 'Recent commits (newest first):'
const MORE = /^… and (\d+) more$/
const DELTA_HEADING = 'Changes since the earlier repository entries:'
const DELTA_ADDED = 'Now listed in the working tree:'
const DELTA_REMOVED = 'No longer listed in the working tree:'
const DELTA_OMITTED = /^Entries not listed: (\d+)$/
const DELTA_NEW_COMMITS = 'New commits (newest first):'
const DELTA_COMMITS = 'Recent commits now (newest first):'

export function composeTurnSnapshot(snapshot: TurnSnapshot): string {
	const body: string[] = []
	if (snapshot.status.length === 0) {
		body.push(TREE_CLEAN)
	} else {
		body.push(TREE_HEADING, ...snapshot.status)
		if (snapshot.omittedStatusLines > 0) {
			body.push(`… and ${snapshot.omittedStatusLines} more`)
		}
	}
	if (snapshot.recentCommits.length > 0) {
		body.push('', COMMITS_HEADING, ...snapshot.recentCommits)
	}
	return [FULL_HEADING, '', wrap(body), '', NOTE_FULL].join('\n')
}

function wrap(body: readonly string[], delta = false): string {
	return wrapUntrusted(
		{
			kind: 'repository-snapshot',
			provenance: delta ? PROVENANCE_DELTA : PROVENANCE,
		},
		body.join('\n'),
		{ brief: delta },
	)
}

/** What an entry says about the tree, in the form entries are compared in. */
interface Known {
	status: Set<string>
	omitted: number
	commits: string[]
}

/** The envelope delimiter is neutralised in what a model sees; compare in that form. */
const neutral = (line: string): string => line.replace(/namzu-untrusted/gi, 'namzu_untrusted')

/** The lines inside the entry's envelope, or null when the entry has none. */
function envelopeLines(entry: string): string[] | null {
	const lines = entry.split('\n')
	const open = lines.findIndex((line) =>
		/^<namzu-untrusted-[0-9a-f]+ kind="repository-snapshot"/.test(line),
	)
	if (open < 0) return null
	const close = lines.findIndex(
		(line, index) => index > open && /^<\/namzu-untrusted-[0-9a-f]+>$/.test(line),
	)
	if (close < 0) return null
	const blank = lines.findIndex((line, index) => index > open && line === '')
	if (blank < 0 || blank > close) return null
	return lines.slice(blank + 1, close)
}

/** Apply one entry (a whole snapshot or a change list) to what is known. */
function apply(known: Known | null, entry: string): Known | null {
	const lines = envelopeLines(entry)
	if (!lines) return null
	const whole = !lines.includes(DELTA_HEADING)
	if (!whole && !known) return null
	const next: Known =
		whole || !known
			? { status: new Set(), omitted: 0, commits: [] }
			: { status: new Set(known.status), omitted: known.omitted, commits: [...known.commits] }
	let section: 'tree' | 'added' | 'removed' | 'commits' | 'newCommits' | 'none' = 'none'
	const newCommits: string[] = []
	let replaced: string[] | null = null
	for (const line of lines) {
		if (line === '' || line === DELTA_HEADING || line === TREE_CLEAN) section = 'none'
		else if (line === TREE_HEADING) section = 'tree'
		else if (line === DELTA_ADDED) section = 'added'
		else if (line === DELTA_REMOVED) section = 'removed'
		else if (line === COMMITS_HEADING) section = 'commits'
		else if (line === DELTA_COMMITS) {
			section = 'commits'
			replaced = []
		} else if (line === DELTA_NEW_COMMITS) section = 'newCommits'
		else if (MORE.test(line) || DELTA_OMITTED.test(line)) {
			next.omitted = Number((MORE.exec(line) ?? DELTA_OMITTED.exec(line))?.[1] ?? 0)
			section = 'none'
		} else if (section === 'tree' || section === 'added') next.status.add(line)
		else if (section === 'removed') next.status.delete(line)
		else if (section === 'commits') {
			if (replaced) replaced.push(line)
			else next.commits.push(line)
		} else if (section === 'newCommits') newCommits.push(line)
	}
	if (replaced) next.commits = replaced
	else if (newCommits.length > 0) next.commits = [...newCommits, ...next.commits]
	return next
}

function knownFrom(entries: readonly string[]): Known | null {
	let known: Known | null = null
	for (const entry of entries) {
		known = apply(known, entry)
		if (known === null) return null
	}
	return known
}

/**
 * The text of the next repository entry, or `null` when the entries already
 * say what the repository looks like. The first entry (and the first after a
 * compaction removed the earlier ones) is the whole snapshot; later ones list
 * only what changed, unless that would be longer than the whole.
 */
export function composeSnapshotEntry(
	earlier: readonly string[],
	snapshot: TurnSnapshot,
): string | null {
	const full = composeTurnSnapshot(snapshot)
	const known = knownFrom(earlier)
	if (!known) return full

	const status = snapshot.status.map(neutral)
	const commits = snapshot.recentCommits.map(neutral)
	const now = new Set(status)
	const added = status.filter((line) => !known.status.has(line))
	const removed = [...known.status].filter((line) => !now.has(line))
	const omittedChanged = snapshot.omittedStatusLines !== known.omitted
	const sameCommits =
		commits.length === known.commits.length && commits.every((c, i) => c === known.commits[i])
	if (added.length === 0 && removed.length === 0 && !omittedChanged && sameCommits) return null

	const body: string[] = [DELTA_HEADING]
	if (added.length > 0)
		body.push(DELTA_ADDED, ...snapshot.status.filter((l) => added.includes(neutral(l))))
	if (removed.length > 0) body.push(DELTA_REMOVED, ...removed)
	if (omittedChanged) body.push(`Entries not listed: ${snapshot.omittedStatusLines}`)
	if (!sameCommits) {
		// Newest first: when the old list continues unchanged after the new
		// commits, only the new ones need naming; anything else (a reset, an
		// amend) is stated as the list it now is.
		const fresh = commits.findIndex(
			(_, i) =>
				known.commits.length >= commits.length - i &&
				known.commits.slice(0, commits.length - i).every((c, j) => c === commits[i + j]),
		)
		if (fresh > 0) body.push(DELTA_NEW_COMMITS, ...snapshot.recentCommits.slice(0, fresh))
		else body.push(DELTA_COMMITS, ...snapshot.recentCommits)
	}
	const delta = wrap(body, true)
	return delta.length < full.length ? delta : full
}

/**
 * Record the repository for the turn: the whole snapshot the first time,
 * afterwards only what differs from what the conversation already holds. The
 * snapshot itself is read once per send by the caller.
 */
export function createRepositorySnapshotStep(snapshot: TurnSnapshot | null): PrepareStep {
	return ({ messages }) => {
		if (!snapshot) return undefined
		const text = composeSnapshotEntry(turnContextEntries(messages, REPOSITORY_ENTRY_KEY), snapshot)
		return text ? { recordedContext: [{ key: REPOSITORY_ENTRY_KEY, text }] } : undefined
	}
}
