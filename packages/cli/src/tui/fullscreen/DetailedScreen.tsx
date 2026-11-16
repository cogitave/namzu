import { Box, Text, useInput } from 'ink'
import { useRef, useState } from 'react'

import { theme } from '../theme.js'
import type { TranscriptMessage } from '../types.js'
import { type FullscreenControl, FullscreenTranscript } from './FullscreenTranscript.js'
import type { FullscreenTranscriptProps } from './FullscreenTranscript.js'

type Passed = Pick<
	FullscreenTranscriptProps,
	| 'messages'
	| 'pending'
	| 'pendingAt'
	| 'columns'
	| 'maxRows'
	| 'subscribeWheel'
	| 'subscribePointer'
	| 'copy'
	| 'copyOnSelect'
	| 'links'
	| 'hyperlinks'
	| 'onNote'
	| 'wheelRows'
	| 'wheelAccel'
	| 'noteMs'
	| 'clock'
>

export interface DetailedScreenProps extends Passed {
	/** A dialog is queued behind the screen and appears when it closes. */
	readonly dialogWaiting: boolean
	/** Back to the composer. */
	readonly onClose: () => void
	/** Opens the whole conversation in the person's editor; absent where there is no editor to ask. */
	readonly onOpenInEditor?: (messages: readonly TranscriptMessage[]) => void
}

/** The keys the header names, longest form first; the first that fits `columns` is drawn. */
export function detailedHeader(columns: number, dialogWaiting: boolean, mouse: boolean): string {
	const prefix = dialogWaiting ? 'dialog waiting · ' : ''
	const forms = [
		`Detailed transcript · esc back · ↑↓ scroll · / search (n N) · v editor${mouse ? ' · click a row to fold · drag to copy' : ''}`,
		`Detailed transcript · esc back · ↑↓ scroll · / search (n N) · v editor${mouse ? ' · click a row to fold' : ''}`,
		'Detailed transcript · esc back · ↑↓ scroll · / search (n N) · v editor',
		'Detailed transcript · esc back · / search · v editor',
		'Detailed transcript · esc back',
	]
	for (const form of forms) if (`${prefix}${form}`.length <= columns) return `${prefix}${form}`
	return `${prefix}${forms.at(-1)}`.slice(0, Math.max(1, columns))
}

/**
 * The detailed transcript on the fullscreen screen (ctrl+o): the whole conversation in the same
 * scrolling window the main view uses, so the wheel scrolls it, a drag selects and copies, a click
 * on a tool row folds it, `/` searches and `v` opens it in the editor. A header names the keys.
 */
export function DetailedScreen({
	dialogWaiting,
	onClose,
	onOpenInEditor,
	...view
}: DetailedScreenProps) {
	const control = useRef<FullscreenControl | null>(null)
	// While the query is being typed, letters are the query and no key of ours.
	const [typing, setTyping] = useState(false)
	useInput((input, key) => {
		const move = control.current?.scroll
		if (key.escape) {
			// Esc first closes a search or lets go of a selection.
			if (!control.current?.takeEscape()) onClose()
			return
		}
		if (key.ctrl && (input === 'o' || input === 'c')) {
			onClose()
			return
		}
		if (typing) return
		if (input === 'q') onClose()
		else if (key.upArrow || input === 'k') move?.('line-up')
		else if (key.downArrow || input === 'j') move?.('line-down')
		else if (key.pageUp || input === 'b' || (key.ctrl && input === 'b')) move?.('page-up')
		else if (key.pageDown || input === ' ' || (key.ctrl && input === 'f')) move?.('page-down')
		else if (key.ctrl && input === 'u') move?.('page-up')
		else if (key.ctrl && input === 'd') move?.('page-down')
		else if (key.home || input === 'g') move?.('top')
		else if (key.end || input === 'G') move?.('bottom')
		else if (input === 'v' && onOpenInEditor) onOpenInEditor(view.messages)
	})
	const click = view.subscribePointer !== undefined
	return (
		<Box flexDirection="column" flexGrow={1}>
			<Text color={theme.text.muted} wrap="truncate-end">
				{detailedHeader(view.columns, dialogWaiting, click)}
			</Text>
			<FullscreenTranscript
				{...view}
				keysActive
				homeEndActive
				detailed
				top={2}
				control={control}
				onSearchChange={(open, typingNow) => setTyping(open && typingNow !== false)}
			/>
		</Box>
	)
}
