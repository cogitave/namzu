/**
 * The transcript as flat rows plus the index the viewport reads.
 *
 * Rows are the scroll view's (`transcript-scroll.ts`): a glyph gutter, wrapped
 * text, a blank row between entries. Each message's rows are kept for as long as
 * the message object and the width stay the same. The transcript holds
 * immutable rows, so a streaming reply is the only message that is laid out
 * again as it grows; the rest of a long history costs a lookup.
 */

import { contentColorForRole } from '../Transcript.js'
import { wrapChoiceText } from '../terminal-choice-text.js'
import { shownTheme } from '../theme-store.js'
import { messageScrollRows, scrollBodyText, scrollTextWidth } from '../transcript-scroll.js'
import type { TranscriptMessage } from '../types.js'
import { wrapJoiners } from './joiners.js'
import { markdownRows } from './markdown-rows.js'
import { type FsRow, plainRow } from './rows.js'
import { type RowIndex, buildRowIndex } from './viewport.js'

/** One message's rows, and the blank row that goes above them when something precedes. */
export interface FsMessageRows {
	readonly gap: FsRow | null
	readonly rows: readonly FsRow[]
}

interface Cached {
	readonly width: number
	readonly hasPrev: boolean
	/** Colours are baked into rows, so a new theme lays them out again. */
	readonly theme: string
	readonly block: FsMessageRows
}

export interface FullscreenLayout {
	readonly rows: readonly FsRow[]
	readonly index: RowIndex
}

/** A reply whose text is Markdown, drawn rendered, as the normal transcript draws it. */
function rendersMarkdown(message: TranscriptMessage): boolean {
	return (
		message.role === 'assistant' &&
		message.content.length > 0 &&
		message.statusRows === undefined &&
		// The rendered rows carry the content only; a reply with a meta suffix keeps
		// the plain rows, which show it as the normal transcript does.
		message.meta === undefined &&
		message.contextView === undefined &&
		message.kind !== 'recap' &&
		!message.group
	)
}

/**
 * The rows of one message at a text width from `scrollTextWidth`. Replies are
 * rendered Markdown; every other message is the scroll view's plain rows, with
 * what the wrap took out of each line recorded so a copy can put it back.
 */
export function fullscreenMessageRows(
	message: TranscriptMessage,
	hasPrev: boolean,
	width: number,
): FsMessageRows {
	const plain = messageScrollRows(message, hasPrev, width)
	const gap = plain.gap ? plainRow(plain.gap) : null
	const first = plain.rows[0]
	const body = wrapChoiceText(scrollBodyText(message), width).length
	if (rendersMarkdown(message) && first) {
		const rows: FsRow[] = markdownRows(
			message.content,
			width,
			contentColorForRole(message.role),
		).map((row, i) => ({
			glyph: i === 0 ? first.glyph : ' ',
			glyphColor: first.glyphColor,
			text: row.text,
			color: first.color,
			spans: row.spans,
			joins: row.joins,
			lead: row.lead,
		}))
		for (const row of plain.rows.slice(body)) rows.push(plainRow(row))
		return { gap, rows }
	}
	const joins = wrapJoiners(
		scrollBodyText(message),
		plain.rows.slice(0, body).map((r) => r.text),
	)
	return {
		gap,
		rows: plain.rows.map((row, i) => plainRow(row, i < body ? (joins[i] ?? null) : null)),
	}
}

/** A cache for `layoutTranscript`; hold one per view. */
export type LayoutCache = WeakMap<TranscriptMessage, Cached>

export function createLayoutCache(): LayoutCache {
	return new WeakMap()
}

/**
 * Lay the conversation out at `columns`. The streaming reply stands at
 * `pendingAt`, as in the live transcript, so no row moves when it finishes.
 */
export function layoutTranscript(
	messages: readonly TranscriptMessage[],
	pending: TranscriptMessage | null,
	pendingAt: number | undefined,
	columns: number,
	cache: LayoutCache,
): FullscreenLayout {
	const at = Math.min(Math.max(pendingAt ?? messages.length, 0), messages.length)
	const ordered = pending ? [...messages.slice(0, at), pending, ...messages.slice(at)] : messages
	const width = scrollTextWidth(columns)
	const theme = shownTheme()
	const rows: FsRow[] = []
	const blocks: { id: string; rows: number; tail: string }[] = []
	ordered.forEach((message, i) => {
		const hasPrev = i > 0
		let hit = cache.get(message)
		if (!hit || hit.width !== width || hit.hasPrev !== hasPrev || hit.theme !== theme) {
			hit = { width, hasPrev, theme, block: fullscreenMessageRows(message, hasPrev, width) }
			cache.set(message, hit)
		}
		const { gap, rows: own } = hit.block
		if (gap) rows.push(gap)
		for (const row of own) rows.push(row)
		blocks.push({
			id: message.id,
			rows: own.length + (gap ? 1 : 0),
			tail: `${message.content.length}:${message.pending ? 1 : 0}`,
		})
	})
	return { rows, index: buildRowIndex(blocks) }
}
