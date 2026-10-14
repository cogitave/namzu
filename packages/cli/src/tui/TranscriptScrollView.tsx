import { Box, Text, useInput } from 'ink'
import { useEffect, useMemo, useState } from 'react'

import { theme } from './theme.js'
import {
	type ScrollMove,
	type ScrollState,
	followHint,
	moveScroll,
	openScroll,
	syncScroll,
	transcriptScrollRows,
} from './transcript-scroll.js'
import type { TranscriptMessage } from './types.js'

export interface TranscriptScrollViewProps {
	/** Finalized messages, oldest first. */
	readonly messages: readonly TranscriptMessage[]
	/** The reply that is still streaming, drawn where it stands. */
	readonly pending: TranscriptMessage | null
	readonly pendingAt?: number
	/** Rows of transcript the window shows, not counting the hint row. */
	readonly height: number
	readonly columns: number
	/** Return to the latest: the view goes away and the session is as it was. */
	readonly onClose: () => void
}

/**
 * The conversation, one window at a time, opened by paging up from the composer.
 *
 * It is a box in the live region like the shell-jobs panel, never the alternate
 * screen: the transcript on the terminal's own scrollback is not touched, and
 * closing this leaves nothing behind. While it is open and reading older rows,
 * a single quiet row above the composer says how to get back.
 */
export function TranscriptScrollView({
	messages,
	pending,
	pendingAt,
	height,
	columns,
	onClose,
}: TranscriptScrollViewProps) {
	const rows = useMemo(
		() => transcriptScrollRows(messages, pending, pendingAt, columns),
		[messages, pending, pendingAt, columns],
	)
	const [state, setState] = useState<ScrollState | null>(() => openScroll(rows, height))
	const view = state === null ? 'latest' : syncScroll(state, rows, height)

	useEffect(() => {
		if (view === 'latest') {
			onClose()
			return
		}
		if (state && (view.unseen !== state.unseen || view.signature !== state.signature))
			setState(view)
	}, [view, state, onClose])

	useInput((input, key) => {
		if (view === 'latest') return
		if (key.escape || (key.ctrl && input === 'c')) {
			onClose()
			return
		}
		let move: ScrollMove | null = null
		if (key.pageUp) move = 'page-up'
		else if (key.pageDown || input === ' ') move = 'page-down'
		else if (key.upArrow || input === 'k') move = 'line-up'
		else if (key.downArrow || input === 'j') move = 'line-down'
		else if (key.home || input === 'g') move = 'top'
		else if (key.end || input === 'G') move = 'bottom'
		if (!move) return
		const next = moveScroll(view, move, rows.length, height)
		if (next === 'latest') onClose()
		else setState(next)
	})

	if (view === 'latest') return null
	const shown = rows.slice(view.top, view.top + height)
	const hint = followHint(columns, view.unseen)
	return (
		<Box flexDirection="column">
			{shown.map((row, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a window of rows has no identity beyond its position.
				<Box key={`${view.top + i}`} flexDirection="row">
					<Box width={2} flexShrink={0}>
						<Text color={row.glyphColor} bold>
							{row.glyph}
						</Text>
					</Box>
					<Text color={row.color} wrap="truncate-end">
						{row.text.length > 0 ? row.text : ' '}
					</Text>
				</Box>
			))}
			<Box justifyContent="center">
				<Text color={view.unseen ? theme.text.secondary : theme.text.muted} wrap="truncate-end">
					{hint ?? ' '}
				</Text>
			</Box>
		</Box>
	)
}
