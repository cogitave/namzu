/**
 * The pure rules of the `/resume` picker: what typing narrows the list to,
 * what the folder switch shows, and how a keystroke edits the search or the
 * name being typed. App owns the state and the keyboard; this owns the
 * decisions, so they are testable without a terminal.
 */

import {
	type PullRequestFilter,
	matchesPullRequestFilter,
} from '../integrations/github/pull-request.js'
import type { RecentConversation } from '../integrations/sessions/store.js'

/** Which conversations the picker lists. */
export type ResumeScope = 'folder' | 'all'

/** `--from-pr`: only the conversations linked to a pull request, or to the one named. */
export function onlyLinkedToPullRequest(
	conversations: readonly RecentConversation[],
	filter: PullRequestFilter | null,
): readonly RecentConversation[] {
	if (filter === null) return conversations
	return conversations.filter((conversation) => matchesPullRequestFilter(conversation.pr, filter))
}

/** Conversations whose title, first message or last message contains every word typed. */
export function filterConversations(
	conversations: readonly RecentConversation[],
	query: string,
): readonly RecentConversation[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean)
	if (words.length === 0) return conversations
	return conversations.filter((conversation) => {
		const haystack = [
			conversation.title,
			conversation.firstPrompt,
			conversation.preview,
			conversation.pr ? `pr #${conversation.pr.number} ${conversation.pr.repository}` : undefined,
		]
			.filter((part): part is string => typeof part === 'string')
			.join('\n')
			.toLowerCase()
		return words.every((word) => haystack.includes(word))
	})
}

/**
 * The first lines of what the person typed to open a conversation: at most
 * `lines` non-empty lines, each cut to `width` characters.
 */
export function openingLines(firstPrompt: string | undefined, lines = 3, width = 200): string[] {
	if (!firstPrompt) return []
	return firstPrompt
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.slice(0, lines)
		.map((line) => (line.length > width ? `${line.slice(0, width - 1)}…` : line))
}

/** The line a text field shows while the person edits it: a key either changes the text or does nothing. */
export interface LineKey {
	readonly input: string
	readonly backspace?: boolean
	readonly delete?: boolean
	readonly ctrl?: boolean
	readonly meta?: boolean
	readonly tab?: boolean
	readonly return?: boolean
	readonly escape?: boolean
	readonly upArrow?: boolean
	readonly downArrow?: boolean
	readonly leftArrow?: boolean
	readonly rightArrow?: boolean
	readonly pageUp?: boolean
	readonly pageDown?: boolean
	readonly home?: boolean
	readonly end?: boolean
}

/** The text after one key, or `null` when the key is not an edit of the text. */
export function editLine(text: string, key: LineKey): string | null {
	if (key.backspace || key.delete) return Array.from(text).slice(0, -1).join('')
	if (key.ctrl || key.meta || key.tab || key.return || key.escape) return null
	if (
		key.upArrow ||
		key.downArrow ||
		key.leftArrow ||
		key.rightArrow ||
		key.pageUp ||
		key.pageDown ||
		key.home ||
		key.end
	)
		return null
	// Control bytes and escape sequences are not text.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control bytes is the point
	const printable = key.input.replace(/[\u0000-\u001f\u007f]/g, '')
	if (printable.length === 0) return null
	return text + printable
}

/** What the picker's header says about the list it shows. */
export function resumeScopeLabel(scope: ResumeScope): string {
	return scope === 'all' ? 'All folders' : 'This folder'
}
