import type { StreamChunk } from '../types/provider/stream.js'

type ToolCallDelta = NonNullable<StreamChunk['delta']['toolCalls']>[number]

/**
 * A stream that broke the tool-call framing every driver promises: one call
 * per `index`, and the call's id before any of its arguments.
 *
 * Both used to be absorbed. A new id on an open index was ignored and its
 * arguments appended to the other call's, and a fragment before the id was
 * dropped with a warning. Either way the buffer that reached `JSON.parse` was
 * not what the model sent, the parse failed, and the model was told its call
 * had been cut off — for a fault in the stream, not in anything it wrote.
 */
export type ToolCallFramingViolation =
	| {
			readonly kind: 'index_reused'
			readonly index: number
			readonly openId: string
			readonly newId: string
	  }
	| { readonly kind: 'fragment_before_id'; readonly index: number }

/**
 * What is wrong with this tool-call delta, given the call already open at its
 * index, or `undefined` when nothing is.
 *
 * The same id repeated on every fragment is fine: some wires send it each
 * time. Only a different one is a second call.
 */
export function toolCallFramingViolation(
	open: { readonly id: string } | undefined,
	delta: ToolCallDelta,
): ToolCallFramingViolation | undefined {
	if (open?.id && delta.id && delta.id !== open.id) {
		return { kind: 'index_reused', index: delta.index, openId: open.id, newId: delta.id }
	}
	if (delta.function?.arguments && !open?.id && !delta.id) {
		return { kind: 'fragment_before_id', index: delta.index }
	}
	return undefined
}

/** One sentence naming the violation, for an error's detail. */
export function describeToolCallFramingViolation(violation: ToolCallFramingViolation): string {
	switch (violation.kind) {
		case 'index_reused':
			return `the stream reused tool-call index ${violation.index} for call "${violation.newId}" while call "${violation.openId}" held it`
		case 'fragment_before_id':
			return `the stream sent arguments for tool-call index ${violation.index} before naming the call's id`
	}
}
