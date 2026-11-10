/**
 * The transcript as flat rows plus the index the viewport reads.
 *
 * Rows are the scroll view's (`transcript-scroll.ts`): a glyph gutter, wrapped
 * text, a blank row between entries. Each message's rows are kept for as long as
 * the message object and the width stay the same. The transcript holds
 * immutable rows, so a streaming reply is the only message that is laid out
 * again as it grows; the rest of a long history costs a lookup.
 */

import {
	type MessageScrollRows,
	type ScrollRow,
	messageScrollRows,
	scrollTextWidth,
} from '../transcript-scroll.js'
import type { TranscriptMessage } from '../types.js'
import { type RowIndex, buildRowIndex } from './viewport.js'

interface Cached {
	readonly width: number
	readonly hasPrev: boolean
	readonly block: MessageScrollRows
}

export interface FullscreenLayout {
	readonly rows: readonly ScrollRow[]
	readonly index: RowIndex
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
	const rows: ScrollRow[] = []
	const blocks: { id: string; rows: number; tail: string }[] = []
	ordered.forEach((message, i) => {
		const hasPrev = i > 0
		let hit = cache.get(message)
		if (!hit || hit.width !== width || hit.hasPrev !== hasPrev) {
			hit = { width, hasPrev, block: messageScrollRows(message, hasPrev, width) }
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
