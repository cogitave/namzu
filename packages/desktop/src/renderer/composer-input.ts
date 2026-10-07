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
