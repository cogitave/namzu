import { createRuntimeContextMessage } from '../../../types/message/index.js'
import type { Message } from '../../../types/message/index.js'

/**
 * Request-only context, as the model reads it: a runtime-context user
 * message of kind `step-context`, labelled so the model does not take it
 * for something the operator just said.
 *
 * Its own module because two sides of an import cycle need it: the
 * working-memory phase, which `step-shaping` reaches through the compaction
 * phase, and `step-shaping` itself.
 */
export function stepContextMessage(content: string) {
	return createRuntimeContextMessage(
		`Current step context (runtime-generated; not a new user request):\n${content}`,
		'step-context',
	)
}

function textOf(message: Message): string {
	return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
}

/**
 * Put a request's own data into it: after everything the history holds, in
 * the order offered, each distinct text once.
 *
 * Request-only data is what the model needs for this request alone (a note
 * that something is unavailable, the work still running). It is re-placed on
 * every call and always last, so the history before it never changes shape
 * from one call to the next and a caching driver, which ends its breakpoint
 * before the first such block, covers the whole history on every call. What
 * the model should keep reading in later requests is recorded as turn context
 * instead (`PrepareStepResult.recordedContext`), and the loop records what it
 * learns about files and finished work the same way.
 *
 * `request` is the projected history. `recorded` are entries the loop has just
 * recorded: they join the history at the end of this call, so they go ahead
 * of the first request-only block already in `request` (`tail` of them, at the
 * end), which is where the next request will find them.
 */
export function placeRequestContext(
	request: Message[],
	recorded: readonly Message[],
	tail: number,
	blocks: readonly Message[],
): void {
	if (recorded.length > 0) request.splice(request.length - tail, 0, ...recorded)
	const seen = new Set<string>()
	for (const message of blocks) {
		const text = textOf(message)
		if (seen.has(text)) continue
		seen.add(text)
		request.push(message)
	}
}
