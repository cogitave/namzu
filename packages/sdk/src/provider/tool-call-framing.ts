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
	/** The index the fragment was placed on, when it came without one. */
	index: number = delta.index,
): ToolCallFramingViolation | undefined {
	if (open?.id && delta.id && delta.id !== open.id) {
		return { kind: 'index_reused', index, openId: open.id, newId: delta.id }
	}
	return undefined
}

/**
 * The index each tool-call fragment of one stream belongs to.
 *
 * A driver sets `index`, and the index is what groups a call's fragments.
 * Some OpenAI-compatible servers leave it out of `tool_calls`, and a driver
 * that passes the wire value through then sends none. Every such fragment used
 * to land on one `undefined` index: two parallel calls were refused as a
 * reused index, and the turn paused on a stream that had nothing wrong with
 * it but the missing field.
 *
 * A fragment with no index is placed by its id, in the order ids arrive: an
 * id seen before continues its call; a new id names the call the latest
 * fragment went to when that call has no id yet, and starts a call on the
 * next free index otherwise; and a fragment with no id continues the call the
 * latest fragment went to. A fragment that does carry an index keeps it, so a
 * well-formed stream is read exactly as before and a real reuse of an index is
 * still refused.
 */
export class ToolCallIndexer {
	private readonly byId = new Map<string, number>()
	private readonly named = new Set<number>()
	private latest: number | undefined
	private next = 0

	/** The index this fragment belongs to. */
	indexOf(delta: { readonly index?: number; readonly id?: string }): number {
		const index = hasIndex(delta.index) ? delta.index : this.placed(delta.id)
		if (delta.id && !this.byId.has(delta.id)) this.byId.set(delta.id, index)
		if (delta.id) this.named.add(index)
		if (index >= this.next) this.next = index + 1
		this.latest = index
		return index
	}

	private placed(id: string | undefined): number {
		if (!id) return this.latest ?? this.next
		const known = this.byId.get(id)
		if (known !== undefined) return known
		return this.latest !== undefined && !this.named.has(this.latest) ? this.latest : this.next
	}

	/**
	 * The index a block close belongs to: its own, or, when it has none, the
	 * call its id names, or the call the latest fragment went to.
	 */
	closedIndex(end: { readonly index?: number; readonly id?: string }): number | undefined {
		if (hasIndex(end.index)) return end.index
		return (end.id ? this.byId.get(end.id) : undefined) ?? this.latest
	}
}

function hasIndex(index: number | undefined): index is number {
	return typeof index === 'number' && Number.isInteger(index) && index >= 0
}

/** One sentence naming the violation, for an error's detail. */
export function describeToolCallFramingViolation(violation: ToolCallFramingViolation): string {
	return `the stream reused tool-call index ${violation.index} for call "${violation.newId}" while call "${violation.openId}" held it`
}
