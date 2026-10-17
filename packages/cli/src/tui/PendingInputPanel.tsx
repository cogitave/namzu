/**
 * Messages the operator sent while Namzu is still working, drawn as rows at
 * the end of the transcript, above the input box, in the passive grey of a
 * message that has not been read yet. A steer belongs to the active reply; a
 * Tab-queued message starts a later one and says so. Read-only: the keys that
 * act on these rows live in the composer.
 */

import { Box, Text } from 'ink'

import {
	choiceDisplayText,
	choiceDisplayWidth,
	truncateChoiceText,
} from './terminal-choice-text.js'
import { theme } from './theme.js'

export interface PendingInputItem {
	readonly text: string
	/** A composed prompt may carry files or images even when its text is empty. */
	readonly attachmentCount?: number
	/** Singular display noun such as "image"; it is treated as untrusted text. */
	readonly attachmentLabel?: string
}

export interface PendingInputPanelProps {
	readonly pendingSteers: readonly PendingInputItem[]
	readonly queued: readonly PendingInputItem[]
	/** Available cells, including the panel's one-cell side padding. */
	readonly columns: number
	readonly rows: number
	/** A reply is running, so "send now" has something to interrupt. */
	readonly working?: boolean
	/** Index into `queued` of the row chosen for editing; it is drawn in the accent colour. */
	readonly selectedQueued?: number | null
	/** A stopped or failed turn keeps the next-turn queue until the operator continues. */
	readonly held?: {
		readonly outcome: 'failed' | 'stopped' | 'paused'
		readonly source?: 'operator-interrupt'
	} | null
}

/** The pointer every pending row carries, as in the reference transcript. */
export const PENDING_POINTER = '❯'
export const SEND_NOW_HINT = 'ctrl+x ctrl+s to send now'

const MAX_PREVIEW_CODEPOINTS = 400
const QUEUED_SUFFIX = ' · after this reply'

/** Read at most one short line per prompt, without walking a huge paste on every repaint. */
function previewText(source: string): string {
	let head = ''
	let count = 0
	let clipped = false
	for (const codePoint of source) {
		if (count === MAX_PREVIEW_CODEPOINTS) {
			clipped = true
			break
		}
		head += codePoint
		count += 1
	}
	const display = choiceDisplayText(head).replace(/\s+/gu, ' ').trim()
	return `${display}${clipped ? '…' : ''}`
}

function attachmentSuffix(item: PendingInputItem): string {
	const count = item.attachmentCount
	if (count === undefined || !Number.isSafeInteger(count) || count < 1) return ''
	const label = item.attachmentLabel ? previewText(item.attachmentLabel) : 'attachment'
	return ` [${count} ${label}${count === 1 ? '' : 's'}]`
}

interface Row {
	readonly key: string
	readonly item: PendingInputItem
	readonly queued: boolean
	readonly queuedIndex: number
}

function allRows(
	pendingSteers: readonly PendingInputItem[],
	queued: readonly PendingInputItem[],
): readonly Row[] {
	return [
		...pendingSteers.map((item, index) => ({
			key: `s${index}`,
			item,
			queued: false,
			queuedIndex: -1,
		})),
		...queued.map((item, index) => ({ key: `q${index}`, item, queued: true, queuedIndex: index })),
	]
}

/** Rows shown at a given height; the rest collapse into one "earlier" row. */
function rowLimit(rows: number): number {
	return rows >= 30 ? 5 : rows >= 20 ? 3 : 1
}

/** The newest `limit` rows, moved back only far enough to keep the selection in view. */
function windowStart(rows: readonly Row[], limit: number, selectedQueued: number | null): number {
	let start = Math.max(0, rows.length - limit)
	if (selectedQueued === null) return start
	const at = rows.findIndex((row) => row.queued && row.queuedIndex === selectedQueued)
	if (at >= 0 && at < start) start = at
	return start
}

function holdText(held: NonNullable<PendingInputPanelProps['held']>): string {
	if (held.source === 'operator-interrupt') {
		return 'Held after you stopped the reply · your next message runs first, then these'
	}
	if (held.outcome === 'paused') return 'Held while the reply is paused'
	return `Paused after the ${held.outcome === 'failed' ? 'failed' : 'stopped'} reply · send a message to run them`
}

function hintRows({
	working,
	held,
	rows,
}: Pick<PendingInputPanelProps, 'working' | 'held' | 'rows'>): number {
	return Number(Boolean(held) || (working === true && rows >= 16))
}

/** Reserve the actual panel height in App's live transcript calculation. */
export function pendingInputPanelRows({
	pendingSteers,
	queued,
	rows,
	working = false,
	held = null,
}: Pick<PendingInputPanelProps, 'pendingSteers' | 'queued' | 'rows' | 'working' | 'held'>): number {
	const total = pendingSteers.length + queued.length
	if (total === 0) return 0
	const limit = rowLimit(rows)
	return Math.min(limit, total) + Number(total > limit) + hintRows({ working, held, rows })
}

export function PendingInputPanel({
	pendingSteers,
	queued,
	columns,
	rows,
	working = false,
	selectedQueued = null,
	held = null,
}: PendingInputPanelProps) {
	const list = allRows(pendingSteers, queued)
	if (list.length === 0) return null

	const limit = rowLimit(rows)
	const start = windowStart(list, limit, selectedQueued)
	const shown = list.slice(start, start + limit)
	const width = Math.max(1, columns - 2)
	const selecting = selectedQueued !== null
	const hint = held ? holdText(held) : working && rows >= 16 ? SEND_NOW_HINT : null
	return (
		<Box flexDirection="column" paddingX={1}>
			{shown.map((row) => {
				const chosen = row.queued && row.queuedIndex === selectedQueued
				const lead = chosen || !selecting ? `${PENDING_POINTER} ` : '  '
				const files = attachmentSuffix(row.item)
				const text =
					previewText(row.item.text) ||
					(row.item.attachmentCount ? '(attachment only)' : '(empty message)')
				const room = Math.max(0, width - choiceDisplayWidth(lead))
				// The "after this reply" note yields before the message does.
				const keep = Math.min(choiceDisplayWidth(text), 12) + choiceDisplayWidth(files)
				const tail =
					row.queued && room - keep >= choiceDisplayWidth(QUEUED_SUFFIX) ? QUEUED_SUFFIX : ''
				const shownFiles = truncateChoiceText(files, Math.max(0, room - choiceDisplayWidth(tail)))
				const shownText = truncateChoiceText(
					text,
					Math.max(0, room - choiceDisplayWidth(tail) - choiceDisplayWidth(shownFiles)),
				)
				const shownTail = tail
				const colour = chosen ? theme.accent.system : theme.text.muted
				return (
					<Text key={row.key} color={colour} wrap="truncate-end">
						{lead}
						{shownText}
						{shownFiles}
						{shownTail ? <Text dimColor>{shownTail}</Text> : null}
					</Text>
				)
			})}
			{list.length > shown.length ? (
				<Text color={theme.text.muted} dimColor wrap="truncate-end">
					{truncateChoiceText(
						`  +${list.length - shown.length} more ${list.length - shown.length === 1 ? 'message' : 'messages'}`,
						width,
					)}
				</Text>
			) : null}
			{hint ? (
				<Text color={theme.text.muted} dimColor wrap="truncate-end">
					{truncateChoiceText(`  ${hint}`, width)}
				</Text>
			) : null}
		</Box>
	)
}
