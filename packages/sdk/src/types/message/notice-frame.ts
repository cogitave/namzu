/**
 * The frame the kernel puts around a notice it sends the model: the operator's
 * message typed while a tool ran, a background job's exit, a monitor's events.
 *
 * A notice is its own user-role message at the next request boundary. It is
 * never appended to a tool result: a tool result carries only what the tool
 * returned, and Namzu's own words inside that slot read as tool output.
 *
 * The frame says what the text is and whose it is, and its tag carries a
 * random marker drawn after the text is fixed (`<namzu-notice-1f3a...>`), so
 * nothing the text says can spell the closing tag. {@link escapeNoticeFrame}
 * is the second layer: it turns every spelling of the tag prefix in tool
 * output and file content into inert text before it reaches the conversation.
 */

import {
	generateRenderNonce,
	nonceClosureStatement,
	pickRenderNonce,
} from '../../tools/render-nonce.js'

/** The fixed prefix of every notice tag; the real tag adds `-<marker>`. */
export const NOTICE_TAG = 'namzu-notice'

export type NoticeKind = 'operator-message' | 'job' | 'monitor'

const OPEN_OR_CLOSE = /<(\/?)(namzu-notice)/gi

/**
 * Make the notice tag inert: `<namzu-notice` becomes `&lt;namzu-notice`, in any
 * case, opening or closing, with or without a marker after it. Idempotent, so
 * text that passes through twice (a result rebuilt on resume) is not changed
 * again.
 */
export function escapeNoticeFrame(text: string): string {
	return text.includes('<') ? text.replace(OPEN_OR_CLOSE, '&lt;$1$2') : text
}

/** What a frame says about whose words are inside it. */
export const NOTICE_PREAMBLE: Readonly<Record<NoticeKind, string>> = {
	'operator-message': '',
	job: 'Namzu sent this automatically. The operator did not write it, so it is neither an answer to a question you asked nor an approval.',
	monitor:
		'Namzu sent this automatically. The operator did not write it, so it is neither an answer to a question you asked nor an approval.',
}

export function noticeTag(nonce: string): string {
	return `${NOTICE_TAG}-${nonce}`
}

export function noticeOpen(kind: NoticeKind, nonce: string): string {
	return `<${noticeTag(nonce)} kind="${kind}">`
}

export function noticeClose(nonce: string): string {
	return `</${noticeTag(nonce)}>`
}

/**
 * `label`, the preamble and the body inside one frame, the body escaped. The
 * marker is drawn fresh for each frame and never occurs in the label or body.
 */
export function frameNotice(
	kind: NoticeKind,
	label: string,
	body: string,
	generateNonce: () => string = generateRenderNonce,
): string {
	const safe = escapeNoticeFrame(body)
	const nonce = pickRenderNonce(generateNonce, [label, safe])
	const lines = [noticeOpen(kind, nonce), label]
	if (NOTICE_PREAMBLE[kind]) lines.push(NOTICE_PREAMBLE[kind])
	lines.push(nonceClosureStatement(noticeClose(nonce)), safe, noticeClose(nonce))
	return lines.join('\n')
}

const OPERATOR_FRAME = new RegExp(
	`^<${NOTICE_TAG}-([0-9a-f]+) kind="operator-message">\\n[^\\n]*\\n[^\\n]*\\n([\\s\\S]*)\\n</${NOTICE_TAG}-\\1>$`,
)

/**
 * The operator's text inside a frame {@link frameNotice} made for an operator
 * message, as the frame held it (tag already made inert), or `undefined` for
 * any other text.
 */
export function readOperatorNotice(content: string): string | undefined {
	return OPERATOR_FRAME.exec(content)?.[2]
}
