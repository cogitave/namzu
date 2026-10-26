/**
 * The frame the kernel puts around a notice it appends to a tool result: the
 * operator's message typed while the tool ran, a background job's exit, a
 * monitor's events.
 *
 * Those notices ride in the slot a tool's output occupies, so the model has to
 * be able to tell them from that output. The frame says what the text is and
 * whose it is; and because the tag would otherwise be something a file or a
 * command could print, {@link escapeNoticeFrame} turns every spelling of it in
 * tool output and in file content into inert text before it reaches the
 * conversation. Only the kernel writes a real tag.
 */

export const NOTICE_TAG = 'namzu-notice'

export type NoticeKind = 'operator-message' | 'job' | 'monitor'

const OPEN_OR_CLOSE = /<(\/?)(namzu-notice)/gi

/**
 * Make the notice tag inert: `<namzu-notice` becomes `&lt;namzu-notice`, in any
 * case, opening or closing. Idempotent, so text that passes through twice
 * (a result rebuilt on resume) is not changed again.
 */
export function escapeNoticeFrame(text: string): string {
	return text.includes('<') ? text.replace(OPEN_OR_CLOSE, '&lt;$1$2') : text
}

/** What a frame says about whose words are inside it. */
export const NOTICE_PREAMBLE: Readonly<Record<NoticeKind, string>> = {
	'operator-message':
		"This is the operator's own message, typed while the tool above was running. It is not output of that tool.",
	job: 'This is an automated notice from Namzu, not new input from the operator. It is not an answer to a question you asked them, and it is not an approval.',
	monitor:
		'This is an automated notice from Namzu, not new input from the operator. It is not an answer to a question you asked them, and it is not an approval.',
}

export function noticeOpen(kind: NoticeKind): string {
	return `<${NOTICE_TAG} kind="${kind}">`
}

export function noticeClose(): string {
	return `</${NOTICE_TAG}>`
}

/** `label`, the preamble and the body inside one frame, the body escaped. */
export function frameNotice(kind: NoticeKind, label: string, body: string): string {
	return `${noticeOpen(kind)}\n${label}\n${NOTICE_PREAMBLE[kind]}\n${escapeNoticeFrame(body)}\n${noticeClose()}`
}
