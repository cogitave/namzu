/** Pure decisions behind the composer's paste, attachment and queue copy. */

export type PasteDecision =
	| { action: 'default' }
	| { action: 'import' }
	| { action: 'notice'; notice: string }

/**
 * Text wins when a clipboard carries both: Office and web copies add an image
 * rendering of the text, and attaching that would discard what the user pasted.
 * Files alone are never swallowed silently when they cannot be attached.
 */
export function decidePaste({
	text,
	fileCount,
	importDisabled,
	attachmentsSupported,
}: {
	text: string
	fileCount: number
	importDisabled: boolean
	attachmentsSupported: boolean
}): PasteDecision {
	if (fileCount === 0 || text.length > 0) return { action: 'default' }
	if (!importDisabled) return { action: 'import' }
	return {
		action: 'notice',
		notice: attachmentsSupported
			? "Files can't be attached here."
			: "This engine doesn't take attachments yet.",
	}
}

export const UNSUPPORTED_ATTACHMENTS_HINT = 'Remove attachments to send with this engine.'

export const PARKED_QUEUE_COPY = 'Paused — these start after your next message finishes.'

/**
 * What the Stop button's tooltip says. While Queue is unavailable it says why, because a disabled
 * Queue button shows no tooltip of its own.
 */
export function stopTooltip(input: {
	waitingOnPerson: boolean
	/** The engine takes a message while a reply is running. */
	liveInputSupported: boolean
	/** Queue is offered but cannot be used right now (nothing typed, or attachments stranded). */
	queueDisabled: boolean
	attachmentsStranded?: boolean
}): string {
	if (input.waitingOnPerson)
		return 'Stop this reply · Esc. The action waiting for you will not run.'
	if (!input.liveInputSupported)
		return "Stop · Esc. This engine can't take a new message while it works."
	if (input.queueDisabled)
		return input.attachmentsStranded
			? 'Stop · Esc. Queue is off: remove the attachments first, this engine cannot take them.'
			: 'Stop · Esc. Queue is off until you type a message.'
	return 'Stop · Esc'
}
