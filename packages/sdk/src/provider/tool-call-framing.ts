import type { StreamChunk } from '../types/provider/stream.js'

type ToolCallDelta = NonNullable<StreamChunk['delta']['toolCalls']>[number]

/**
 * A stream that broke tool-call framing: a second call id on an `index`
 * another call holds.
 *
 * The index is what groups a call's fragments, so after this no buffer can be
 * trusted to hold one call's arguments. The second call's arguments used to be
 * appended to the first's; the buffer that reached `JSON.parse` was then not
 * what the model sent, and the model was told its call had been cut off.
 *
 * Nothing else about a call's framing is a violation. Arguments that arrive
 * before the call's id belong to the call at their index and are kept, and a
 * call whose id never arrives is still one call.
 */
export interface ToolCallFramingViolation {
	readonly kind: 'index_reused'
	readonly index: number
	readonly openId: string
	readonly newId: string
}

/**
 * Whether this tool-call delta puts a new call on an index another call
 * holds, or `undefined` when it does not.
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
	return undefined
}

/** One sentence naming the violation, for an error's detail. */
export function describeToolCallFramingViolation(violation: ToolCallFramingViolation): string {
	return `the stream reused tool-call index ${violation.index} for call "${violation.newId}" while call "${violation.openId}" held it`
}
