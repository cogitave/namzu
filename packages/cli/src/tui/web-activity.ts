/**
 * How a web search or a page fetch reads in the conversation.
 *
 * A search is one row naming what was searched for, `Web search("query")`,
 * and one `⎿` line under it that says how it is going while it runs
 * (`Searching: query`) and what it came to once it settled
 * (`Found 5 results in 3.2s`, `Did 1 search in 9.0s`). A fetch is the same
 * shape with the address: `Web fetch(https://…)`, `Fetching docs.example.com…`,
 * `Received 7.5KB in 1.2s`. Consecutive web rows sit together without a blank
 * line between them (`Transcript.tsx`), so three searches read as one burst of
 * work rather than three separate events.
 *
 * The query is shown whole on the row and the terminal cuts it at its own
 * width with an ellipsis; nothing here shortens it to a guessed width.
 *
 * Pure, and here rather than in `App.tsx`, so every sentence is testable.
 */

import { formatElapsed } from './units.js'

export type WebActivityKind = 'search' | 'fetch'

/** What the host knows about one web call. Everything but `kind` may be unknown. */
export interface WebActivity {
	readonly kind: WebActivityKind
	/** The query searched for, or the address fetched. */
	readonly target?: string
	/** Results the provider or tool reported. Absent means unknown, not zero. */
	readonly results?: number
	/** Run inside the provider's own request: there is no local output to show. */
	readonly hosted?: boolean
}

/** The web kind of a registry tool name, or `undefined` for every other tool. */
export function webActivityKind(toolName: string): WebActivityKind | undefined {
	if (toolName === 'web_search') return 'search'
	if (toolName === 'web_fetch') return 'fetch'
	return undefined
}

/**
 * The web activity a local tool call describes, read from its input.
 *
 * `query` for a search and `url` for a fetch, which is what both the SDK's own
 * tools and the Exa-backed search take. Anything else is left unnamed rather
 * than guessed at.
 */
export function webActivityFromInput(toolName: string, input: unknown): WebActivity | undefined {
	const kind = webActivityKind(toolName)
	if (!kind) return undefined
	const field = kind === 'search' ? 'query' : 'url'
	const value =
		input !== null && typeof input === 'object'
			? (input as Record<string, unknown>)[field]
			: undefined
	const target = typeof value === 'string' ? oneLine(value) : ''
	return target.length > 0 ? { kind, target } : { kind }
}

/** `Web search("query")`, `Web fetch(https://…)`, or the bare name when nothing is known yet. */
export function webCallTitle(activity: WebActivity): string {
	const target = activity.target ? oneLine(activity.target) : ''
	if (activity.kind === 'search') return target ? `Web search("${target}")` : 'Web search'
	return target ? `Web fetch(${target})` : 'Web fetch'
}

/** The `⎿` line while the call runs. */
export function webLiveStatus(activity: WebActivity): string {
	const target = activity.target ? oneLine(activity.target) : ''
	if (activity.kind === 'search') return target ? `Searching: ${target}` : 'Searching…'
	return target ? `Fetching ${hostOf(target)}…` : 'Fetching…'
}

/** The `⎿` line once the call settled successfully. */
export function webSettledLine(
	activity: WebActivity,
	outcome: { readonly durationMs?: number; readonly bytes?: number },
): string {
	const took = outcome.durationMs !== undefined ? ` in ${formatElapsed(outcome.durationMs)}` : ''
	if (activity.kind === 'search') {
		const n = activity.results
		return n !== undefined ? `Found ${n} result${n === 1 ? '' : 's'}${took}` : `Did 1 search${took}`
	}
	return outcome.bytes !== undefined
		? `Received ${formatBytes(outcome.bytes)}${took}`
		: `Fetched${took}`
}

/**
 * How many results a local search listed.
 *
 * The SDK's search prints one `N. title` line per hit and Exa one `URL: …`
 * line per hit; whichever shape the output has is counted. Output with neither
 * — an error, or a service that answered in prose — counts as unknown.
 */
export function countListedResults(output: string | undefined): number | undefined {
	if (!output) return undefined
	const lines = output.split('\n')
	const numbered = lines.filter((line) => /^\s{0,3}\d+\.\s+\S/.test(line)).length
	const addressed = lines.filter((line) => /^\s*URL:\s*\S/.test(line)).length
	const count = Math.max(numbered, addressed)
	return count > 0 ? count : undefined
}

/** `512B`, `7.5KB`, `1.2MB`. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function hostOf(target: string): string {
	try {
		return new URL(target).host || target
	} catch {
		return target
	}
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim()
}
