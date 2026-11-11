/**
 * The failures of three reads that used to be logged as "unclassified" and shown as "That didn't
 * work": the undo status, the message settings and the model and provider setup. Each has one
 * reason the diagnostic log records and one plain sentence the person reads where they are (the
 * undo dialog, the settings row, the model row). Main and the renderer share this table, so a
 * reason in the log and the sentence on screen cannot drift apart.
 */
export type NamedFailureReason =
	| 'undo-status-invalid'
	| 'undo-status-unavailable'
	| 'settings-unavailable'
	| 'provider-not-configured'
	| 'provider-setup-unavailable'

export const NAMED_FAILURE_SENTENCES: Record<NamedFailureReason, string> = {
	'undo-status-invalid':
		'Namzu could not tell which files this reply changed. Close this and open the conversation again.',
	'undo-status-unavailable':
		'Namzu could not check whether this reply can be undone. It will try once more when the connection comes back.',
	'settings-unavailable': 'Saved message settings could not be loaded. Try again.',
	'provider-not-configured':
		'This model is not set up yet. Open the model list to set it up, or choose another model.',
	'provider-setup-unavailable':
		'The models could not be loaded. Choose Try again, or they load again when Namzu reconnects.',
}

/** Names that match a message of one of these failures, whatever read raised it. */
const BY_MESSAGE: { match: RegExp; reason: NamedFailureReason }[] = [
	{ match: /invalid undo status/i, reason: 'undo-status-invalid' },
	{ match: /provider.*not configured/i, reason: 'provider-not-configured' },
]

const UNDO_OPERATIONS = new Set(['undoStatus', 'namzu/turns/undo-status'])
const SETTINGS_OPERATIONS = new Set(['draftSettings', 'saveDraftSettings', 'modelSettings'])
const PROVIDER_OPERATIONS = new Set([
	'providers',
	'models',
	'namzu/providers/status',
	'namzu/providers/models',
	'namzu/providers/settings',
])

/**
 * The named reason for a failure of one of these reads, or undefined for any other. A message that
 * says what went wrong wins; a read that failed without saying falls back to the read's own name.
 */
export function namedFailure(message: string, operation?: string): NamedFailureReason | undefined {
	const byMessage = BY_MESSAGE.find((item) => item.match.test(message))
	if (byMessage) return byMessage.reason
	if (!operation) return undefined
	if (UNDO_OPERATIONS.has(operation)) return 'undo-status-unavailable'
	if (SETTINGS_OPERATIONS.has(operation)) return 'settings-unavailable'
	if (PROVIDER_OPERATIONS.has(operation)) return 'provider-setup-unavailable'
	return undefined
}

/** The sentence for the failure of a read, or undefined when it is not one of the named ones. */
export function namedFailureSentence(message: string, operation?: string): string | undefined {
	const reason = namedFailure(message, operation)
	return reason ? NAMED_FAILURE_SENTENCES[reason] : undefined
}
