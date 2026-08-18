import type { TerminalNotificationEvent, TerminalNotificationMethod } from '../../config/schema.js'

/** A semantic TUI moment, before it is rendered for a terminal protocol. */
export type TerminalNotification =
	| { readonly kind: 'approval-required' }
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
	if (setting === true) return true
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
		if (method === 'bel') output.write('\x07')
		else output.write(`\x1b]9;${notificationText(notification)}\x07`)
		return { kind: 'request-sent' }
	} catch (err) {
		return {
			kind: 'write-failed',
			detail: err instanceof Error ? err.message : String(err),
		}
	}
}

function notificationText(notification: TerminalNotification): string {
	if (notification.kind === 'approval-required') return 'Namzu: approval required'
	switch (notification.outcome) {
		case 'completed':
			return 'Namzu: turn completed'
		case 'stopped':
			return 'Namzu: turn needs attention'
		case 'failed':
			return 'Namzu: turn failed'
	}
}
