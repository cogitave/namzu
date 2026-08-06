/**
 * Where the agent is and when it is.
 *
 * The kernel already tells the model the working directory and the platform.
 * It does not tell it the DATE, and it does not tell it anything about the
 * repository. Both are missing facts a coding agent needs constantly and
 * cannot get right by guessing:
 *
 * - **The date.** A model with no clock answers from its training cut-off. It
 *   writes that date into a changelog entry, into the `last_updated` frontmatter
 *   this repository's own docs carry, into a copyright header — and reasons
 *   about "the current version" of everything from a year that has passed.
 *   Nothing about the output looks wrong; it is confidently, quietly stale.
 * - **The branch.** "Commit this" means something different on a release branch
 *   than on a scratch one, and an agent that has to spend a tool call to find
 *   out spends it on every session.
 *
 * ## What is deliberately NOT here
 *
 * **The working tree's dirty state.** It is the fact a reader will most want to
 * add, and adding it would cost real money for nothing. This block goes into
 * the system prompt, which is the CACHED prefix of every request; a file count
 * that changes whenever the agent saves a file would re-key that prefix on
 * essentially every turn. The date changes once a day and a branch changes
 * rarely, so those two are cheap to carry — and `git status` is one tool call
 * away for an agent that actually needs it, which is the right place to pay.
 *
 * Read fresh each turn for the same reason the branch is worth having at all: a
 * session that crosses midnight, or in which the agent checks out a branch
 * itself, must not keep asserting what was true when it started. Because the
 * text only changes when the fact changes, a fresh read costs a cache miss
 * exactly when a cache hit would have been wrong.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Bound on a single git call. A wedged repository must not stall a turn. */
const GIT_TIMEOUT_MS = 2_000

export interface EnvironmentFacts {
	/** ISO calendar date, `YYYY-MM-DD`, in the machine's own timezone. */
	readonly today: string
	/**
	 * `branch` when on one, `null` when the working directory is not a
	 * repository, `'detached'` when it is one with no branch checked out.
	 */
	readonly branch: string | null
	readonly isRepository: boolean
}

/**
 * The machine's local calendar date.
 *
 * Local, not UTC: the user's "today" is the one on their wall, and an agent
 * that writes tomorrow's date into a changelog because the machine is eight
 * hours behind UTC has made exactly the mistake this exists to prevent.
 */
export function localIsoDate(now: Date): string {
	const pad = (n: number): string => String(n).padStart(2, '0')
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

async function git(cwd: string, args: readonly string[]): Promise<string | null> {
	try {
		const { stdout } = await run('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS })
		const out = stdout.trim()
		return out.length > 0 ? out : null
	} catch {
		// No git on the machine, not a repository, or the call timed out. All
		// three mean the same thing to a caller: this fact is unavailable, and
		// the block below simply does not claim it.
		return null
	}
}

export async function readEnvironmentFacts(
	cwd: string,
	now: Date = new Date(),
): Promise<EnvironmentFacts> {
	// `symbolic-ref` rather than `rev-parse --abbrev-ref HEAD`, because it
	// answers on an unborn branch — a freshly initialised repository with no
	// commit yet, where `rev-parse HEAD` fails and would be read as "not a
	// repository". Both calls at once: they are independent and each is a
	// process.
	const [insideWorkTree, branch] = await Promise.all([
		git(cwd, ['rev-parse', '--is-inside-work-tree']),
		git(cwd, ['symbolic-ref', '--short', 'HEAD']),
	])
	const isRepository = insideWorkTree === 'true'
	return {
		today: localIsoDate(now),
		// A repository with no symbolic HEAD is on a detached one. Distinguishing
		// that from "not a repository" matters: on a detached HEAD a commit goes
		// nowhere reachable, and an agent about to commit should know.
		branch: isRepository ? (branch ?? 'detached') : null,
		isRepository,
	}
}

export function composeEnvironmentPrompt(facts: EnvironmentFacts): string {
	const lines = [`Today's date is ${facts.today}.`]
	if (!facts.isRepository) {
		lines.push('The working directory is not a git repository.')
	} else if (facts.branch === 'detached') {
		lines.push(
			'The working directory is a git repository with a detached HEAD — no branch is checked out, so a commit made here is not reachable from any branch.',
		)
	} else {
		lines.push(`The working directory is a git repository on branch \`${facts.branch}\`.`)
	}
	lines.push(
		'These are facts about right now. Prefer them over any date or branch you would otherwise assume.',
	)
	return `## Environment\n\n${lines.join('\n')}`
}
