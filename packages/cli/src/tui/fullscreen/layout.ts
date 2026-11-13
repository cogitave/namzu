/**
 * The transcript as flat rows plus the index the viewport reads.
 *
 * Rows are the scroll view's (`transcript-scroll.ts`): a glyph gutter, wrapped
 * text, a blank row between entries. Each message's rows are kept for as long as
 * the message object, the width and its own open state stay the same, so opening
 * one row lays out that one message and nothing else. The transcript holds
 * immutable rows, so a streaming reply is the only message that is laid out
 * again as it grows; the rest of a long history costs a lookup.
 */

import { contentColorForRole, screenMessage } from '../Transcript.js'
import { grammarVersion } from '../code-highlight.js'
import { newRepliesRule } from '../new-output.js'
import { tailView } from '../stream-flow.js'
import { RESULT_GUTTER_INDENT, RESULT_GUTTER_WIDTH } from '../system-rows.js'
import { wrapChoiceText } from '../terminal-choice-text.js'
import { shownTheme } from '../theme-store.js'
import { theme as palette } from '../theme.js'
import {
	messageScrollRows,
	scrollBodyText,
	scrollTextWidth,
	withLiveHint,
} from '../transcript-scroll.js'
import { CLICK_EXPAND_HINT, CLICK_FOLD_HINT, EXPAND_HINT } from '../truncation.js'
import type { TranscriptMessage } from '../types.js'
import { wrapJoiners } from './joiners.js'
import { markdownRows } from './markdown-rows.js'
import { ReplyRows, type RowWrap } from './reply-rows.js'
import { type FsRow, plainRow } from './rows.js'
import { type RowIndex, buildRowIndex } from './viewport.js'

/** A reply being written, and what it was laid out for. */
export interface StreamedReply {
	readonly key: string
	readonly rows: ReplyRows
}

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
	readonly click: boolean
	readonly open: boolean
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

/** How a message is drawn: whether a click is the way to open it, and whether it is open. */
export interface RowMode {
	readonly click: boolean
	readonly open: boolean
}

const PLAIN: RowMode = { click: false, open: false }

/** The message as an open row shows it: what the detailed transcript shows, and how to fold it. */
function openedMessage(message: TranscriptMessage): TranscriptMessage {
	const shown = screenMessage(message)
	const meta = message.meta ?? ''
	const kept = (meta.endsWith(EXPAND_HINT) ? meta.slice(0, -EXPAND_HINT.length) : meta)
		.replace(/[\s·]+$/u, '')
		.trim()
	const fullHeader = message.shell?.fullHeader
	return {
		...shown,
		...(fullHeader !== undefined ? { content: fullHeader } : {}),
		meta: kept.length > 0 ? `${kept} · ${CLICK_FOLD_HINT}` : CLICK_FOLD_HINT,
	}
}

/** Cells a result row's `⎿` and the gap after it take before its words, as the normal transcript draws it. */
const RESULT_HANG = RESULT_GUTTER_INDENT + RESULT_GUTTER_WIDTH - 2

/** A `⎿` result line has its words hung after the mark, in the column the normal transcript uses. */
function hangsResult(message: TranscriptMessage): boolean {
	return (
		(message.glyph ?? '') === '⎿' &&
		message.statusRows === undefined &&
		!(message.group && message.shell === undefined)
	)
}

/**
 * A result line's body rows with the `⎿` set into the text: the gutter is two
 * cells, and the mark stands one column further in than that, so it is part of
 * the first row (in its own colour) and the rows after it hang under the words.
 */
function hungRows(rows: readonly FsRow[], body: number, markColor: string): readonly FsRow[] {
	return rows.map((row, i) => {
		if (i >= body) return row
		const prefix = i === 0 ? `⎿${' '.repeat(RESULT_HANG - 1)}` : ' '.repeat(RESULT_HANG)
		return {
			...row,
			glyph: ' ',
			text: `${prefix}${row.text}`,
			lead: i === 0 ? 0 : RESULT_HANG,
			spans: [
				{ text: prefix, color: i === 0 ? markColor : row.color },
				{ text: row.text, color: row.color },
			],
		}
	})
}

/**
 * The rows of a message that carries the expand hint, worded as a click, or
 * null when it carries none. Only what the hint stands for answers a click: the
 * line the message opens from, the commands a group lists under it, and the
 * hint's own row. An open message answers on its line alone, so a click in the
 * text it opened to selects it instead of folding it.
 */
function clickableRows(
	message: TranscriptMessage,
	hasPrev: boolean,
	width: number,
	open: boolean,
): FsMessageRows | null {
	if (message.role !== 'tool' && message.role !== 'system') return null
	const fit = hangsResult(message) ? Math.max(4, width - RESULT_HANG) : width
	const closed = messageScrollRows(message, hasPrev, fit, { hint: CLICK_EXPAND_HINT })
	if (!closed.hinted) return null
	const shown = open ? openedMessage(message) : message
	const hint = open ? undefined : CLICK_EXPAND_HINT
	const plain = open ? messageScrollRows(shown, hasPrev, fit) : closed
	const text = scrollBodyText(shown, hint, fit)
	const body = wrapChoiceText(text, fit).length
	const joins = wrapJoiners(
		text,
		plain.rows.slice(0, body).map((r) => r.text),
	)
	const own = plain.rows.map((row, i) => plainRow(row, i < body ? (joins[i] ?? null) : null))
	const laid = hangsResult(message) ? hungRows(own, body, plain.rows[0]?.glyphColor ?? '') : own
	return {
		gap: plain.gap ? plainRow(plain.gap) : null,
		rows: laid.map((own, i) => {
			const answers =
				i < body || (!open && (plain.rows[i]?.command === true || plain.rows[i]?.hint === true))
			return answers ? { ...own, opens: true as const } : own
		}),
	}
}

/**
 * The rows of one message at a text width from `scrollTextWidth`. Replies are
 * rendered Markdown; every other message is the scroll view's plain rows, with
 * what the wrap took out of each line recorded so a copy can put it back.
 * With `mode.click` a message that carries the expand hint says "click" and
 * marks the rows a click answers; `mode.open` draws it open.
 */
export function fullscreenMessageRows(
	asked: TranscriptMessage,
	hasPrev: boolean,
	width: number,
	mode: RowMode = PLAIN,
	streams?: Map<string, StreamedReply>,
): FsMessageRows {
	const message = withLiveHint(asked)
	if (mode.click) {
		const clickable = clickableRows(message, hasPrev, width, mode.open)
		if (clickable) return clickable
	}
	const hung = hangsResult(message)
	const fit = hung ? Math.max(4, width - RESULT_HANG) : width
	const markdown = rendersMarkdown(message)
	// A reply's own rows come from its Markdown. The plain rows are only asked for
	// the glyph, the gap and what stands after the text, none of which depends on
	// the text, so a one-letter stand-in is wrapped instead of the whole reply:
	// wrapping every character of a long reply at each piece that streams in was
	// what kept the window from answering keys.
	const plain = messageScrollRows(markdown ? { ...message, content: 'x' } : message, hasPrev, fit)
	const gap = plain.gap ? plainRow(plain.gap) : null
	const first = plain.rows[0]
	const body = markdown ? 1 : wrapChoiceText(scrollBodyText(message, undefined, fit), fit).length
	if (markdown && first) {
		const color = contentColorForRole(message.role)
		const wrap: RowWrap = (row, i) => ({
			glyph: i === 0 ? first.glyph : ' ',
			glyphColor: first.glyphColor,
			text: row.text,
			color: first.color,
			spans: row.spans,
			joins: row.joins,
			lead: row.lead,
		})
		// A reply that is being written keeps what is decided of it from one piece to the
		// next, so that a piece costs what it brought (`reply-rows.ts`); one that is
		// finished, or has no state, is laid out from its text.
		const kept = streams && (message.pending || streams.has(message.id))
		const key = `${width}|${color}|${shownTheme()}:${grammarVersion()}|${first.glyph}|${first.glyphColor}|${first.color}`
		let held = kept ? streams.get(message.id) : undefined
		if (kept && (!held || held.key !== key)) {
			held = { key, rows: new ReplyRows(width, color, wrap) }
			streams.set(message.id, held)
		}
		const streamed = held?.rows.update(message.content, !message.pending)
		const rows: FsRow[] = streamed ?? []
		if (!streamed) {
			// A reply still being written is drawn as far as it is decided: the fullscreen
			// view redraws freely, so it only needs the tail rules, not the printing.
			const shown = message.pending
				? tailView(message.content, { join: 'block', lead: null })
				: message.content
			markdownRows(shown, width, color).forEach((row, i) => rows.push(wrap(row, i)))
		}
		for (const row of plain.rows.slice(body)) rows.push(plainRow(row))
		return { gap, rows }
	}
	const joins = wrapJoiners(
		scrollBodyText(message, undefined, fit),
		plain.rows.slice(0, body).map((r) => r.text),
	)
	const own = plain.rows.map((row, i) => plainRow(row, i < body ? (joins[i] ?? null) : null))
	return {
		gap,
		rows: hung ? hungRows(own, body, first?.glyphColor ?? '') : own,
	}
}

/** A cache for `layoutTranscript`; hold one per view. */
export interface LayoutCache {
	readonly kept: WeakMap<TranscriptMessage, Cached>
	/** What is kept of the reply being written, by message id: one at a time. */
	readonly streams: Map<string, StreamedReply>
	/** Messages laid out so far: the cost a change to one message is measured by. */
	laid: number
}

export function createLayoutCache(): LayoutCache {
	return { kept: new WeakMap(), streams: new Map(), laid: 0 }
}

/** What the view does with a click: which messages are open, by id. */
export interface ClickView {
	readonly click: boolean
	readonly open: ReadonlySet<string>
}

/** The rule drawn above the first reply the reader has not seen. */
export interface UnseenMark {
	/** Id of the message the rule stands above. */
	readonly before: string
	/** How many replies are new, for the rule's words. */
	readonly count: number
}

/** The id the rule's own entry in the row index carries; no message has it. */
export const MARK_ID = '\u0000new-replies'

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
	view: ClickView = { click: false, open: new Set() },
	unseen: UnseenMark | null = null,
): FullscreenLayout {
	const at = Math.min(Math.max(pendingAt ?? messages.length, 0), messages.length)
	const ordered = pending ? [...messages.slice(0, at), pending, ...messages.slice(at)] : messages
	const width = scrollTextWidth(columns)
	// Colours are baked into rows: a new theme, or a code grammar that has just arrived, lays them out again.
	const theme = `${shownTheme()}:${grammarVersion()}`
	const rows: FsRow[] = []
	const blocks: { id: string; rows: number; tail: string }[] = []
	ordered.forEach((message, i) => {
		const hasPrev = i > 0
		if (unseen && message.id === unseen.before && hasPrev) {
			// One quiet row above the message's own gap. It is an entry of its own in
			// the index, so no message's anchor or rows move because of it.
			rows.push({
				glyph: ' ',
				glyphColor: palette.text.muted,
				text: '',
				color: palette.text.muted,
				joins: null,
				lead: 0,
				mark: newRepliesRule(unseen.count, width),
			})
			blocks.push({ id: MARK_ID, rows: 1, tail: '' })
		}
		const mode: RowMode = { click: view.click, open: view.click && view.open.has(message.id) }
		let hit = cache.kept.get(message)
		if (
			!hit ||
			hit.width !== width ||
			hit.hasPrev !== hasPrev ||
			hit.theme !== theme ||
			hit.click !== mode.click ||
			hit.open !== mode.open
		) {
			hit = {
				width,
				hasPrev,
				theme,
				click: mode.click,
				open: mode.open,
				block: fullscreenMessageRows(message, hasPrev, width, mode, cache.streams),
			}
			cache.kept.set(message, hit)
			cache.laid += 1
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
	// Only the reply being written keeps its rows: a finished one has them in its message.
	for (const id of cache.streams.keys()) if (id !== pending?.id) cache.streams.delete(id)
	return { rows, index: buildRowIndex(blocks) }
}
