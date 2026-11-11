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
			? 'Files can’t be attached here.'
			: 'This engine doesn’t take attachments yet.',
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
		return 'Stop · Esc. This engine can’t take a new message while it works.'
	if (input.queueDisabled)
		return input.attachmentsStranded
			? 'Stop · Esc. Queue is off: remove the attachments first, this engine cannot take them.'
			: 'Stop · Esc. Queue is off until you type a message.'
	return 'Stop · Esc'
}

/** What the message box and the saved draft hold at most. */
export const DRAFT_LIMIT = 50000

/**
 * How many characters of a paste the box could not take. The box cuts a paste at its limit without
 * saying so, so the person is told what was left out.
 */
export function pasteOverflow({
	current,
	selectionStart,
	selectionEnd,
	pasted,
	limit = DRAFT_LIMIT,
}: {
	current: string
	selectionStart: number
	selectionEnd: number
	pasted: string
	limit?: number
}): number {
	const kept = current.length - Math.abs(selectionEnd - selectionStart)
	return Math.max(0, kept + pasted.length - limit)
}

export function pasteOverflowNotice(left: number, limit = DRAFT_LIMIT): string {
	return `The box holds ${limit.toLocaleString('en-US')} characters, so the last ${left.toLocaleString('en-US')} of that paste ${left === 1 ? 'was' : 'were'} left out.`
}

/** The key that goes with Enter to hold a message for after the reply, as this computer names it. */
export function queueModifierName(mac: boolean): string {
	return mac ? 'Cmd' : 'Ctrl'
}

/** The empty message box's hint. While a reply runs it teaches what Enter and the queue chord do. */
export function composerPlaceholder(input: {
	compact: boolean
	cliMode: boolean
	cliLabel: string
	/** A waiting message can be taken back with the up arrow. */
	editableQueued: boolean
	hasDraft: boolean
	/** A question waits for the person; the bar says so. */
	waitingOnPerson?: boolean
	running: boolean
	/** Enter reaches the running reply instead of waiting behind it. */
	liveInputSupported: boolean
	mac: boolean
}): string {
	if (input.cliMode) return `Optional first message for ${input.cliLabel} in a terminal`
	if (input.editableQueued && !input.hasDraft) return 'Press ↑ to edit queued messages'
	if (input.waitingOnPerson && !input.hasDraft) return 'Waiting for you. Type to message Namzu.'
	if (input.running)
		return input.liveInputSupported
			? `Enter sends now · ${queueModifierName(input.mac)}+Enter or Tab sends after this reply`
			: 'Enter sends after this reply'
	return input.compact ? 'Send a message' : 'Ask Namzu anything'
}
