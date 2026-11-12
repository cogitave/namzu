import type { Message, RuntimeContextMessageKind } from '@namzu/sdk'
import { sanitizeLine } from '../integrations/notifications/desktop/sanitize.js'

/** Human label for provider-user-role context authored by the runtime. */
export function runtimeContextLabel(kind: RuntimeContextMessageKind): string {
	switch (kind) {
		case 'step-context':
			return 'Context for the next step'
		case 'advisory':
			return 'Second opinion'
		case 'answer-review':
			return 'Reviewed the answer'
		case 'auto-continuation':
			return 'Continued automatically'
		case 'hook-feedback':
			return 'Hook feedback'
		case 'job-exit':
			return 'Background command ended'
		case 'limit-finalization':
			return 'Wrapped up at a limit'
		case 'peer-message':
			return 'Message from another Namzu window'
		case 'person-message':
			return 'Message from another terminal of this account'
		case 'host-observation':
			return 'Pal activity'
		case 'channel-message':
			return 'Message from a connected channel'
		case 'peer-notice':
			return 'Notice from another Namzu window'
		case 'progress-nudge':
			return 'Asked to act'
		case 'reminder':
			return 'Reminder'
		case 'refusal-retry':
			return 'Retried after a stopped reply'
		case 'repeat-call':
			return 'Repeated call warning'
		case 'steering':
			return 'Guidance from Namzu'
		case 'structured-output':
			return 'Asked again for the required format'
		case 'task-completion':
			return 'Task finished'
		case 'turn-context':
			return 'Earlier context'
	}
}

/**
 * Whether a message is context the runtime wrote for the model alone: a hidden
 * reminder (the task-list nudge among them) or the context a turn recorded.
 * Nothing the person reads (the live transcript, exports, a host's history
 * view) shows these.
 */
export function isModelOnlyContext(message: Message): boolean {
	return (
		message.role === 'user' &&
		message.source?.type === 'runtime-context' &&
		(message.source.kind === 'reminder' || message.source.kind === 'turn-context')
	)
}

/** The longest a person's words are drawn on their one transcript line; the model and the log hold all of it. */
const PERSON_ROW_MAX = 400

/**
 * The words inside a recorded person message frame, or undefined when the content is not one. The frame is
 * the kernel's: tag, fixed header, closing statement, a blank line, the words, the closing tag with its
 * nonce on the last line. Anything else is not read as a person's words.
 */
export function personMessageWords(content: string): string | undefined {
	const lines = content.split('\n')
	const open = /^<person-message-([A-Za-z0-9]+) origin="another-terminal"/.exec(lines[0] ?? '')
	if (!open || lines.length < 5 || lines[3] !== '') return undefined
	if (lines[lines.length - 1] !== `</person-message-${open[1]}>`) return undefined
	return lines.slice(4, -1).join('\n')
}

/**
 * The transcript line for a recorded runtime-context message: the kernel's label, and for the person's own
 * message their words after it as one safe line (no line break, control or direction character), so a
 * reopened conversation and the watcher show what was said, as the live terminal does.
 */
export function runtimeContextRowLabel(message: Message): string {
	const kind =
		message.role === 'user' && message.source?.type === 'runtime-context'
			? message.source.kind
			: undefined
	if (kind === undefined) return ''
	const label = runtimeContextLabel(kind)
	if (kind !== 'person-message') return label
	const words =
		message.role === 'user' && typeof message.content === 'string'
			? personMessageWords(message.content)
			: undefined
	return words === undefined ? label : `${label}: ${sanitizeLine(words, PERSON_ROW_MAX)}`
}
