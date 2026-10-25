import { Box, Text, measureElement, useInput } from 'ink'
import type { DOMElement } from 'ink'
import { useEffect, useRef, useState } from 'react'

import { ContentWidth } from './Markdown.js'
import { ScreenMessageRow } from './Transcript.js'
import { theme } from './theme.js'
import { screenDivider, screenFooter, screenWindow } from './transcript-screen.js'
import type { TranscriptMessage } from './types.js'

export interface TranscriptScreenProps {
	/** Finalized messages, oldest first. */
	readonly messages: readonly TranscriptMessage[]
	/** The reply that is still streaming, drawn where it stands. */
	readonly pending: TranscriptMessage | null
	readonly pendingAt?: number
	/** Terminal rows; the screen never grows past them. */
	readonly rows: number
	readonly columns: number
	/** A dialog is queued behind the screen and appears when it closes. */
	readonly dialogWaiting: boolean
	readonly hyperlinks?: boolean
	/** Back to the composer. */
	readonly onClose: () => void
}

/** Rows the footer takes: the margin, the rule and the line itself. */
const FOOTER_ROWS = 3
/** Rows left to the terminal so the frame stays shorter than the screen. */
const SCREEN_SLACK = 1

/**
 * The conversation drawn in full: every tool body whole, the model's thinking,
 * no hint that points here. It stands in for the composer while it is open and
 * leaves nothing behind in scrollback. The newest row is at the bottom; the
 * arrow, page, `g` and `G` keys move through what is taller than the terminal.
 */
export function TranscriptScreen({
	messages,
	pending,
	pendingAt,
	rows,
	columns,
	dialogWaiting,
	hyperlinks = false,
	onClose,
}: TranscriptScreenProps) {
	const [showAll, setShowAll] = useState(false)
	// Rows scrolled up from the newest; 0 follows the stream.
	const [offset, setOffset] = useState(0)
	const [contentRows, setContentRows] = useState(0)
	const content = useRef<DOMElement>(null)
	const height = Math.max(3, rows - FOOTER_ROWS - SCREEN_SLACK)
	const maxOffset = Math.max(0, contentRows - height)
	const at = Math.min(Math.max(pendingAt ?? messages.length, 0), messages.length)
	const ordered = pending ? [...messages.slice(0, at), pending, ...messages.slice(at)] : messages
	const { hiddenCount, shown } = screenWindow(ordered, showAll)
	const divider = screenDivider(hiddenCount, showAll)

	useEffect(() => {
		if (content.current) {
			const measured = measureElement(content.current).height
			if (measured !== contentRows) setContentRows(measured)
		}
	})

	useInput((input, key) => {
		if (key.escape || input === 'q' || (key.ctrl && (input === 'o' || input === 'c'))) {
			onClose()
			return
		}
		if (key.ctrl && input === 'e') {
			setShowAll((value) => !value)
			setOffset(0)
			return
		}
		const page = Math.max(1, height - 1)
		if (key.upArrow || input === 'k') setOffset((o) => Math.min(maxOffset, o + 1))
		else if (key.downArrow || input === 'j') setOffset((o) => Math.max(0, o - 1))
		else if (key.pageUp || (key.ctrl && input === 'b') || input === 'b')
			setOffset((o) => Math.min(maxOffset, o + page))
		else if (key.pageDown || input === ' ' || (key.ctrl && input === 'f'))
			setOffset((o) => Math.max(0, o - page))
		else if (key.ctrl && input === 'u') setOffset((o) => Math.min(maxOffset, o + page / 2))
		else if (key.ctrl && input === 'd') setOffset((o) => Math.max(0, o - Math.floor(page / 2)))
		else if (key.home || input === 'g') setOffset(maxOffset)
		else if (key.end || input === 'G') setOffset(0)
	})

	const footer = screenFooter({ showAll, dialogWaiting, columns: Math.max(10, columns - 12) })
	return (
		<Box flexDirection="column">
			<Box
				height={contentRows > 0 ? Math.min(height, contentRows) : height}
				flexDirection="column"
				justifyContent="flex-end"
				overflow="hidden"
			>
				<Box
					ref={content}
					flexDirection="column"
					flexShrink={0}
					marginBottom={-Math.min(offset, maxOffset)}
				>
					<ContentWidth.Provider value={Math.max(10, columns - 4)}>
						{divider ? (
							<Box>
								<Text color={theme.text.muted} wrap="truncate-end">
									{'──── '}
									{divider[0]}
									<Text bold>{divider[1]}</Text>
									{divider[2]}{' '}
									{'─'.repeat(
										Math.max(
											0,
											columns - 4 - 6 - divider[0].length - divider[1].length - divider[2].length,
										),
									)}
								</Text>
							</Box>
						) : null}
						{shown.map((message, i) => (
							<ScreenMessageRow
								key={message.id}
								message={message}
								prev={i > 0 ? shown[i - 1] : undefined}
								hyperlinks={hyperlinks}
							/>
						))}
					</ContentWidth.Provider>
				</Box>
			</Box>
			<Box
				marginTop={1}
				borderStyle="single"
				borderColor={theme.text.muted}
				borderTop
				borderBottom={false}
				borderLeft={false}
				borderRight={false}
				paddingLeft={2}
				justifyContent="space-between"
			>
				<Text wrap="truncate-end">
					{footer.prefix ? <Text color={theme.status.warn}>{footer.prefix}</Text> : null}
					<Text color={theme.text.muted}>{footer.text}</Text>
				</Text>
				<Text color={theme.text.muted}>verbose</Text>
			</Box>
		</Box>
	)
}
