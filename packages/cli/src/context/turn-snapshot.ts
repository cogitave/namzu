/**
 * What the repository looked like when the user's turn began.
 *
 * `environment.ts` deliberately keeps the working tree's dirty state out of
 * the system prompt: that block is the cached prefix, and a file count that
 * changes whenever the agent saves would re-key the cache every turn. The
 * counter-argument is just as real — an agent that does not know a tree is
 * dirty commits somebody else's half-finished work, and an agent that does
 * not know the last five commits re-does one of them.
 *
 * Both are right, and the SDK already has the placement that reconciles
 * them: a `turn` prompt contribution rides the ephemeral trailing message,
 * is never cached and never enters history. Reading the snapshot once per
 * user turn and rendering it on the FIRST iteration only gives the model the
 * state it started from at the cost of one uncached message, and leaves later
 * iterations to `git status` for anything that changed since — which the
 * model itself changed, and knows about.
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

import { wrapUntrusted } from '@namzu/sdk'

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

export function composeTurnSnapshot(snapshot: TurnSnapshot): string {
	const body: string[] = []
	if (snapshot.status.length === 0) {
		body.push('Working tree: clean.')
	} else {
		body.push('Working tree (git status --short):', ...snapshot.status)
		if (snapshot.omittedStatusLines > 0) {
			body.push(`… and ${snapshot.omittedStatusLines} more`)
		}
	}
	if (snapshot.recentCommits.length > 0) {
		body.push('', 'Recent commits (newest first):', ...snapshot.recentCommits)
	}
	return [
		'## Repository at the start of this turn',
		'',
		wrapUntrusted(
			{
				kind: 'repository-snapshot',
				provenance:
					'File names and commit subjects read from the working directory with git. They were written by whoever committed or created them.',
			},
			body.join('\n'),
		),
		'',
		'This is a snapshot from when the turn started; it does not update as you work. Run `git status` before any action that depends on the current state.',
	].join('\n')
}
