/**
 * A small, read-only account of input the operator has already submitted.
 * A steer belongs to the active turn; a queued prompt starts a later turn.
 * Neither should disappear into a count-only status line while work continues.
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
	/** Only an operator-authored queued prompt can be recalled for editing. */
	readonly canRecall?: boolean
	/** The exact operator-authored item that Alt+Up restores. */
	readonly recallItem?: PendingInputItem
	/** One-line summary of armed queued composer triggers. */
	readonly queuedTags?: string
	/** A stopped or failed turn keeps the next-turn queue until the operator continues. */
	readonly held?: { readonly outcome: 'failed' | 'stopped' | 'paused'; readonly source?: 'operator-interrupt' } | null
}

const MAX_PREVIEW_CODEPOINTS = 400
const COMPACT_BELOW_ROWS = 24

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

function fit(source: string, columns: number): string {
	return truncateChoiceText(source, Math.max(1, columns - 2))
}

function itemRow(item: PendingInputItem, width: number): string {
	const prefix = width >= 5 ? '  ↳ ' : ''
	const suffix = attachmentSuffix(item)
	const available = Math.max(0, width - choiceDisplayWidth(prefix))
	const shownSuffix = truncateChoiceText(suffix, available)
	const text =
		previewText(item.text) || (item.attachmentCount ? '(attachment only)' : '(empty message)')
	const textWidth = Math.max(0, available - choiceDisplayWidth(shownSuffix))
	return `${prefix}${truncateChoiceText(text, textWidth)}${shownSuffix}`
}

function overflowRow(
	section: 'steering' | 'queued',
	items: readonly PendingInputItem[],
	limit: number,
	canRecall: boolean,
	width: number,
): string {
	const hidden = items.length - limit
	const count = `  +${hidden} more ${section}`
	const latest = items.at(-1)
	if (section !== 'queued' || !canRecall || !latest) return truncateChoiceText(count, width)
	const preview =
		previewText(latest.text) || (latest.attachmentCount ? '(attachment only)' : '(empty message)')
	return truncateChoiceText(`${count} · last: ${preview}`, width)
}

/** At short viewport heights, leave room for the transcript and composer. */
function previewLimit(rows: number): number {
	return rows >= 20 ? 2 : 1
}

/** Reserve the actual panel height in App's live transcript calculation. */
export function pendingInputPanelRows({
	pendingSteers,
	queued,
	rows,
	canRecall = false,
}: Pick<PendingInputPanelProps, 'pendingSteers' | 'queued' | 'rows' | 'canRecall'>): number {
	if (rows < COMPACT_BELOW_ROWS) {
		return Number(pendingSteers.length > 0) + Number(queued.length > 0) +
			Number(canRecall && queued.length > 0)
	}
	const limit = previewLimit(rows)
	const sectionRows = (count: number) => count === 0 ? 0 : 1 + Math.min(limit, count) + Number(count > limit)
	return sectionRows(pendingSteers.length) + sectionRows(queued.length) +
		Number(canRecall && queued.length > 0)
}

function compactRow(label: string, items: readonly PendingInputItem[], width: number): string {
	const prefix = `${label}${items.length > 1 ? ` ${items.length}` : ''} `
	const first = items[0]
	if (!first) return ''
	const suffix = `${attachmentSuffix(first)}${items.length > 1 ? ` (+${items.length - 1})` : ''}`
	const available = Math.max(0, width - choiceDisplayWidth(prefix))
	const shownSuffix = truncateChoiceText(suffix, available)
	const shownText = previewText(first.text) || (first.attachmentCount ? '(attachment only)' : '(empty message)')
	return `${prefix}${truncateChoiceText(shownText, Math.max(0, available - choiceDisplayWidth(shownSuffix)))}${shownSuffix}`
}

function queuedHeading(held: PendingInputPanelProps['held']): string {
	if (!held) return 'Queued · next turn'
	if (held.source === 'operator-interrupt') return 'Queued · held after interruption'
	if (held.outcome === 'paused') return 'Queued · held after a resumable turn paused'
	return `Queued · paused after a ${held.outcome} turn`
}

export function PendingInputPanel({
	pendingSteers,
	queued,
	columns,
	rows,
	canRecall = false,
	recallItem,
	queuedTags = '',
	held = null,
}: PendingInputPanelProps) {
	if (pendingSteers.length === 0 && queued.length === 0) return null

	const limit = previewLimit(rows)
	const width = Math.max(1, columns - 2)
	const recalled = recallItem ?? queued.at(-1)
	if (rows < COMPACT_BELOW_ROWS) {
		return (
			<Box flexDirection="column" paddingX={1}>
				{pendingSteers.length > 0 ? (
					<Text color={theme.accent.user} wrap="truncate-end">{fit(compactRow('Steer→turn', pendingSteers, width), columns)}</Text>
				) : null}
				{queued.length > 0 ? (
					<Text color={theme.text.secondary} wrap="truncate-end">{fit(compactRow(held ? 'Queue held' : 'Queue→next', queued, width), columns)}</Text>
				) : null}
				{canRecall && recalled ? (
					<Text color={theme.text.muted} wrap="truncate-end">
						{fit(`Alt+Up edit last message: ${previewText(recalled.text) || '(attachment only)'}`, columns)}
					</Text>
				) : null}
			</Box>
		)
	}
	const sections = [
		{ id: 'steering', label: 'Steering · next model boundary', items: pendingSteers },
		{ id: 'queued', label: `${queuedHeading(held)}${queuedTags}`, items: queued },
	] as const

	return (
		<Box flexDirection="column" paddingX={1}>
			{sections.map((section) =>
				section.items.length === 0 ? null : (
					<Box key={section.id} flexDirection="column">
						<Text
							color={section.id === 'steering' ? theme.accent.user : theme.text.secondary}
							wrap="truncate-end"
						>
							{fit(section.label, columns)}
						</Text>
						{section.items.slice(0, limit).map((item, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: these text-only preview rows hold no state.
							<Text key={index} color={theme.text.muted} wrap="truncate-end">
								{itemRow(item, width)}
							</Text>
						))}
						{section.items.length > limit ? (
							<Text color={theme.text.muted} wrap="truncate-end">
								{overflowRow(section.id, section.items, limit, canRecall, width)}
							</Text>
						) : null}
					</Box>
				),
			)}
		{canRecall && recalled ? (
			<Text color={theme.text.muted} wrap="truncate-end">
				{fit(`Alt+Up edit last message: ${previewText(recalled.text) || '(attachment only)'}`, columns)}
				</Text>
			) : null}
		</Box>
	)
}
