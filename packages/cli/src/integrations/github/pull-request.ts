/**
 * Pull requests and conversations: which pull request a conversation made or
 * worked on, and how a person asks for the conversations that did.
 *
 * A conversation is linked when a shell command that changes a pull request
 * (`gh pr create`, `gh pr merge`, `glab mr create`, …) succeeds and prints the
 * request's address. The link is a record in the conversation's own log
 * (a `session_updated` external reference), so it survives a rebuild of the
 * index and travels with the log. Nothing here talks to a host: the address in
 * the command's output is the only source.
 */

import type { SessionRecord } from '@namzu/sdk'

/** Protocol name under which a pull request is filed as an external reference. */
export const PULL_REQUEST_PROTOCOL = 'pull-request'

export interface PullRequestLink {
	readonly number: number
	readonly url: string
	/** `owner/repo` (or a nested group path on hosts that have them). */
	readonly repository: string
}

const PR_URL =
	/https?:\/\/[^/\s"'<>]+\/([^\s"'<>]+?)\/(?:pull|pull-requests|-\/merge_requests)\/(\d+)/g

/** The last pull request address in `output`, or `null`. */
export function parsePullRequestLink(output: string): PullRequestLink | null {
	let last: RegExpExecArray | null = null
	for (const match of output.matchAll(PR_URL)) last = match
	if (last === null) return null
	const [url, repository, digits] = last
	const number = Number.parseInt(digits ?? '', 10)
	if (!repository || !Number.isSafeInteger(number) || number <= 0) return null
	return { number, url, repository }
}

// Words inside quotes are text, not commands: blank them before looking.
const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g

const GH_VERBS = 'create|edit|merge|comment|close|reopen|ready'
const GLAB_VERBS = 'create|update|merge|note|close|reopen'
const GH_PR = new RegExp(`(?:^|[\\s;&|(])gh\\s+pr\\s+(?:${GH_VERBS})(?=\\s|$|[;&|)])`)
const GLAB_MR = new RegExp(`(?:^|[\\s;&|(])glab\\s+mr\\s+(?:${GLAB_VERBS})(?=\\s|$|[;&|)])`)

/**
 * Whether a shell command changes a pull request (so that the address it
 * prints is the request this conversation worked on). A dry run changes
 * nothing and never links.
 */
export function commandChangesPullRequest(command: string): boolean {
	const bare = command.replace(QUOTED, (quoted) => ' '.repeat(quoted.length))
	if (/(?:^|\s)--dry-run(?=\s|$|=)/.test(bare)) return false
	return GH_PR.test(bare) || GLAB_MR.test(bare)
}

/**
 * The pull request a finished shell call links its conversation to, or `null`.
 * Only a call that succeeded and changed a pull request links.
 */
export function pullRequestOfShellCall(call: {
	readonly command: string | undefined
	readonly output: string | undefined
	readonly isError: boolean
}): PullRequestLink | null {
	if (call.isError || !call.command || !call.output) return null
	if (!commandChangesPullRequest(call.command)) return null
	return parsePullRequestLink(call.output)
}

/** What `--from-pr [value]` asks for. */
export type PullRequestFilter =
	| { readonly kind: 'any' }
	| { readonly kind: 'number'; readonly number: number }

/**
 * Read the value of `--from-pr`: nothing (any linked conversation), a number,
 * or a pull request address. Anything else is refused with a plain sentence.
 */
export function parsePullRequestFilter(
	value: string | true,
): PullRequestFilter | { readonly error: string } {
	if (value === true) return { kind: 'any' }
	const text = value.trim()
	if (text === '') return { kind: 'any' }
	const bare = text.replace(/^#/, '')
	if (/^\d+$/.test(bare)) {
		const number = Number.parseInt(bare, 10)
		if (Number.isSafeInteger(number) && number > 0) return { kind: 'number', number }
	}
	const link = parsePullRequestLink(text)
	if (link) return { kind: 'number', number: link.number }
	return {
		error: `--from-pr takes a pull request number or address, got "${text}". Leave the value out to list every conversation that made or worked on one.`,
	}
}

/** The external reference a link is recorded as. */
export function pullRequestRef(link: PullRequestLink): {
	readonly protocol: string
	readonly kind: 'context'
	readonly externalId: string
} {
	return { protocol: PULL_REQUEST_PROTOCOL, kind: 'context', externalId: link.url }
}

/** The pull request a conversation's log last linked, or `undefined`. */
export function pullRequestOfRecords(
	records: readonly SessionRecord[],
): PullRequestLink | undefined {
	let found: PullRequestLink | undefined
	for (const record of records) {
		if (record.type !== 'session_updated') continue
		for (const ref of record.externalRefs?.add ?? []) {
			if (ref.protocol !== PULL_REQUEST_PROTOCOL) continue
			const link = parsePullRequestLink(ref.externalId)
			if (link) found = link
		}
	}
	return found
}

/** `owner/repo#12` for a row of the conversation list. */
export function pullRequestLabel(link: Pick<PullRequestLink, 'number' | 'repository'>): string {
	return `${link.repository}#${link.number}`
}

/** Whether a conversation matches the filter. */
export function matchesPullRequestFilter(
	pr: Pick<PullRequestLink, 'number'> | undefined,
	filter: PullRequestFilter,
): boolean {
	if (pr === undefined) return false
	return filter.kind === 'any' || pr.number === filter.number
}
