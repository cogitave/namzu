import type { TerminalNotificationEvent, TerminalNotificationMethod } from '../../config/schema.js'

/** A semantic TUI moment, before it is rendered for a terminal protocol. */
export type TerminalNotification =
	| { readonly kind: 'approval-required' }
	/** A finished turn left alone for a minute; see `idle.ts`. */
	| { readonly kind: 'idle-prompt' }
	| {
			readonly kind: 'turn-settled'
			readonly outcome: 'completed' | 'stopped' | 'failed'
	  }

export interface TerminalNotificationOutput {
	readonly isTTY?: boolean
	readonly write: (data: string) => void
}

export type TerminalNotificationResult =
	| { readonly kind: 'request-sent' }
	| { readonly kind: 'unavailable'; readonly detail: string }
	| { readonly kind: 'write-failed'; readonly detail: string }

/** Whether one configured setting includes this semantic event. */
export function terminalNotificationEnabled(
	setting: boolean | readonly TerminalNotificationEvent[] | undefined,
	notification: TerminalNotification,
): boolean {
	// `true` keeps meaning the two moments it always meant. The idle notice is
	// new and is asked for by name: `['idle-prompt']`.
	if (setting === true) return notification.kind !== 'idle-prompt'
	if (!Array.isArray(setting)) return false
	return setting.includes(notification.kind)
}

/**
 * Send one fixed, content-free notification request through Ink's stdout.
 *
 * Neither protocol acknowledges that a terminal displayed anything. Success
 * therefore means only that the request was written, never that a desktop
 * notification appeared or a bell was audible.
 */
export function writeTerminalNotification(
	notification: TerminalNotification,
	method: TerminalNotificationMethod,
	output: TerminalNotificationOutput,
): TerminalNotificationResult {
	if (!output.isTTY) {
		return { kind: 'unavailable', detail: 'stdout is not an interactive terminal' }
	}

	try {
		const text = notificationText(notification)
		if (method === 'bel') output.write('\x07')
		else if (method === 'kitty') {
			// Kitty's notification protocol (OSC 99): title, body, then a request
			// to focus the window when the notice is clicked, all under one id.
			const id = nextKittyId()
			output.write(`\x1b]99;i=${id}:d=0:p=title;${TITLE}\x07`)
			output.write(`\x1b]99;i=${id}:p=body;${text}\x07`)
			output.write(`\x1b]99;i=${id}:d=1:a=focus;\x07`)
		} else if (method === 'ghostty') output.write(`\x1b]777;notify;${TITLE};${text}\x07`)
		else output.write(`\x1b]9;${TITLE}: ${text}\x07`)
		return { kind: 'request-sent' }
	} catch (err) {
		return {
			kind: 'write-failed',
			detail: err instanceof Error ? err.message : String(err),
		}
	}
}

const TITLE = 'Namzu'

let kittyId = 0
/** Kitty groups the three writes of one notice by a small integer id. */
function nextKittyId(): number {
	kittyId = (kittyId + 1) % 10_000
	return kittyId
}

function notificationText(notification: TerminalNotification): string {
	if (notification.kind === 'approval-required') return 'approval required'
	if (notification.kind === 'idle-prompt') return 'waiting for your input'
	switch (notification.outcome) {
		case 'completed':
			return 'turn completed'
		case 'stopped':
			return 'turn needs attention'
		case 'failed':
			return 'turn failed'
	}
}
