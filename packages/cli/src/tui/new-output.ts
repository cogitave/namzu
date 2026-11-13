/**
 * What a reader who scrolled up is told about the output below. Both scrolling
 * views (the fullscreen window and the default screen's scroll-back box) use
 * this one counter and one ladder of wordings, so the two always agree.
 *
 * What counts is a reply of the model that has text to read. A tool call, a
 * status row or a reply that only has thinking is not one, and a reply that was
 * being written when the reader left and has since grown is not new, it is the
 * same reply longer.
 */

import { choiceDisplayWidth } from './terminal-choice-text.js'
import type { TranscriptMessage } from './types.js'

/** The messages the model's replies are, in the order they stand. */
export function replyList(
	messages: readonly TranscriptMessage[],
	pending: TranscriptMessage | null,
	pendingAt?: number,
): readonly TranscriptMessage[] {
	const at = Math.min(Math.max(pendingAt ?? messages.length, 0), messages.length)
	const ordered = pending ? [...messages.slice(0, at), pending, ...messages.slice(at)] : messages
	return ordered.filter(isReply)
}

/** A reply of the model with visible text. */
export function isReply(message: TranscriptMessage): boolean {
	return (
		message.role === 'assistant' &&
		message.kind === undefined &&
		message.statusRows === undefined &&
		message.contextView === undefined &&
		/\S/u.test(message.content)
	)
}

/** What the transcript held when the reader left the end. */
export interface ReplyBaseline {
	readonly replies: number
	/** The newest reply then, and how long it was. */
	readonly last: { readonly id: string; readonly length: number } | null
}

export function baselineOf(replies: readonly TranscriptMessage[]): ReplyBaseline {
	const last = replies.at(-1)
	return {
		replies: replies.length,
		last: last ? { id: last.id, length: last.content.length } : null,
	}
}

/** What is new since the baseline. */
export interface News {
	/** Replies that did not exist when the reader left. */
	readonly count: number
	/** No new reply, but the one that was newest has grown. */
	readonly grown: boolean
	/** The reply that grew is still being written. */
	readonly writing?: boolean
	/** Something below changed that is not a reply (a tool call, a status row). */
	readonly activity: boolean
}

export function newsSince(
	baseline: ReplyBaseline,
	replies: readonly TranscriptMessage[],
	activity: boolean,
	writing = false,
): News {
	const count = Math.max(0, replies.length - baseline.replies)
	const last = baseline.last
	const grown =
		count === 0 &&
		last !== null &&
		replies.some((reply) => reply.id === last.id && reply.content.length > last.length)
	return { count, grown, activity, ...(grown && writing ? { writing: true } : {}) }
}

export const NO_NEWS: News = { count: 0, grown: false, activity: false }

export function hasNews(news: News): boolean {
	return news.count > 0 || news.grown || news.activity
}

/** The words that go with the arrow, long and short, and the key that does it. */
export interface HintWords {
	readonly long: string
	readonly short: string
	readonly key: string
}

/** The head of the hint, in two lengths; null when there is no news. */
function head(news: News): { readonly full: string; readonly short: string } | null {
	if (news.count > 0) {
		return {
			full: `${news.count} new ${news.count === 1 ? 'reply' : 'replies'}`,
			short: `${news.count} new`,
		}
	}
	if (news.grown) {
		return news.writing
			? { full: 'Reply still growing', short: 'Growing' }
			: { full: 'Reply grew', short: 'Grew' }
	}
	if (news.activity) return { full: 'New activity', short: 'New' }
	return null
}

/**
 * The one row that says how to get back: the first wording that fits, so it
 * shortens before it ever wraps and never cuts a word. The full wording, then
 * shorter ones, and last the count alone (or the arrow when there is no
 * count). Null only when not even that fits.
 */
export function newOutputHint(columns: number, news: News, words: HintWords): string | null {
	const h = head(news)
	const ladder: string[] = h
		? [
				`${h.full} · ↓ ${words.long} · ${words.key}`,
				`${h.full} · ↓ ${words.short} · ${words.key}`,
				`${h.short} · ↓ ${words.short}`,
				...(news.count > 0 ? [`${news.count} new ↓`, `${news.count}`] : [`↓ ${words.short}`, '↓']),
			]
		: [`↓ ${words.long} · ${words.key}`, `↓ ${words.short} · ${words.key}`, `↓ ${words.short}`, '↓']
	return ladder.find((label) => choiceDisplayWidth(label) <= columns) ?? null
}

/** The wording of the rule drawn in the transcript where the new part begins. */
export function newRepliesRule(count: number, width: number): string {
	const word = count === 1 ? 'reply' : 'replies'
	// Shorter wordings for a narrow row; the last is cut to the width, never past it.
	const fits = [`${count} new ${word}`, `${count} new`, `${count}`].find(
		(text) => choiceDisplayWidth(text) <= width,
	)
	if (fits === undefined) return `${count}`.slice(0, Math.max(0, width))
	const label = ` ${fits} `
	const room = Math.max(0, width - choiceDisplayWidth(label))
	if (room < 4) return fits
	const left = Math.floor(room / 2)
	return `${'─'.repeat(left)}${label}${'─'.repeat(room - left)}`
}

/**
 * Whether the person sent a message after message `id`, or `id` is gone: the
 * conversation has moved on from the place the rule marked.
 */
export function promptAfter(messages: readonly TranscriptMessage[], id: string): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (!message) continue
		if (message.id === id) return false
		if (message.role === 'user' && message.kind === undefined) return true
	}
	return true
}
