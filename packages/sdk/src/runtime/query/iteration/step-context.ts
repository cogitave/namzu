import { createRuntimeContextMessage } from '../../../types/message/index.js'

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
