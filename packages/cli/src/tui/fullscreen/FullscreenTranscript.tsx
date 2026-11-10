import { Box, type DOMElement, Text, measureElement, useInput } from 'ink'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { theme } from '../theme.js'
import type { TranscriptMessage } from '../types.js'
import { createLayoutCache, layoutTranscript } from './layout.js'
import type { WheelDirection } from './mouse-wheel.js'
import {
	FOLLOWING,
	type ViewMove,
	type ViewState,
	hasUnseen,
	jumpHint,
	moveView,
	syncView,
	visibleRange,
} from './viewport.js'

/** What the owner of the screen can ask of the view. */
export interface FullscreenControl {
	scroll(move: ViewMove): void
}

export interface FullscreenTranscriptProps {
	/** Finalized messages, oldest first. */
	readonly messages: readonly TranscriptMessage[]
	/** The reply that is still streaming, drawn where it stands. */
	readonly pending: TranscriptMessage | null
	readonly pendingAt?: number
	/** Columns the rows are laid out in, glyph gutter included. */
	readonly columns: number
	/** The tallest the view can be: rows drawn above this are never needed. */
	readonly maxRows: number
	/** Rows shown only when the view is scrolled to the very top. */
	readonly header?: ReactNode
	/** A lifecycle surface owns the screen: keep the room, draw nothing. */
	readonly hidden?: boolean
	/** Page Down, Home and End scroll only while this is on. */
	readonly keysActive: boolean
	/** Home and End move the composer's cursor while it has text. */
	readonly homeEndActive: boolean
	readonly subscribeWheel: (listener: (direction: WheelDirection) => void) => () => void
	readonly control: { current: FullscreenControl | null }
}

/**
 * The conversation on the alternate screen: a window onto the rows, not the
 * rows themselves.
 *
 * The box takes whatever height the live region (spinner, composer, footer)
 * leaves and clips from the top. Only the rows that can be on screen are
 * built into elements, so the cost of a frame follows the terminal's height,
 * not the conversation's. Scrolled up, one row above the composer says how to
 * get back; the view holds still while output arrives.
 */
export function FullscreenTranscript({
	messages,
	pending,
	pendingAt,
	columns,
	maxRows,
	header,
	hidden = false,
	keysActive,
	homeEndActive,
	subscribeWheel,
	control,
}: FullscreenTranscriptProps) {
	const cache = useRef(createLayoutCache()).current
	const { rows, index } = useMemo(
		() => layoutTranscript(messages, pending, pendingAt, columns, cache),
		[messages, pending, pendingAt, columns, cache],
	)
	const [view, setView] = useState<ViewState>(FOLLOWING)
	const boxRef = useRef<DOMElement>(null)
	// Pages and the top clamp want the room actually on screen. It is only read
	// when the reader acts, so it needs no state of its own.
	const roomRef = useRef(maxRows)
	const room = useCallback((): number => {
		const node = boxRef.current
		if (node) {
			const measured = measureElement(node).height
			if (measured > 0) roomRef.current = measured
		}
		// Scrolled up, the jump hint takes one of those rows.
		return Math.max(1, Math.min(roomRef.current, maxRows) - 1)
	}, [maxRows])

	const synced = syncView(view, index, Math.max(1, roomRef.current - 1))
	useEffect(() => {
		if (synced !== view) setView(synced)
	}, [synced, view])

	const latest = useRef({ synced, index })
	latest.current = { synced, index }
	const scroll = useCallback(
		(move: ViewMove) => {
			const { synced: state, index: now } = latest.current
			setView(moveView(state, move, now, room()))
		},
		[room],
	)
	useEffect(() => {
		control.current = { scroll }
		return () => {
			control.current = null
		}
	}, [control, scroll])
	useEffect(
		() => subscribeWheel((direction) => scroll(direction === 'up' ? 'line-up' : 'line-down')),
		[subscribeWheel, scroll],
	)

	useInput(
		(input, key) => {
			if (key.pageDown) scroll('page-down')
			else if (homeEndActive && key.home) scroll('top')
			else if (homeEndActive && key.end) scroll('bottom')
			else if (
				!key.pageUp &&
				!latest.current.synced.follow &&
				(key.return || (input.length > 0 && !key.ctrl && !key.meta))
			)
				// Typing is a reason to look at the end again.
				setView(FOLLOWING)
		},
		{ isActive: keysActive },
	)

	const { from, to } = visibleRange(synced, index, maxRows)
	const unseen = hasUnseen(synced, index)
	const hint = synced.follow ? null : jumpHint(columns, unseen)
	return (
		<Box
			ref={boxRef}
			flexDirection="column"
			flexGrow={1}
			flexShrink={1}
			flexBasis={0}
			overflowY="hidden"
			justifyContent="flex-end"
		>
			{hidden ? null : (
				<Box flexDirection="column" flexShrink={0}>
					{from === 0 && header ? <Box>{header}</Box> : null}
					{rows.slice(from, to).map((row, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a window of rows has no identity beyond its position.
						<Box key={from + i} flexDirection="row">
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
					{hint ? (
						<Box justifyContent="center">
							<Text color={unseen ? theme.text.secondary : theme.text.muted} wrap="truncate-end">
								{hint}
							</Text>
						</Box>
					) : null}
				</Box>
			)}
		</Box>
	)
}
