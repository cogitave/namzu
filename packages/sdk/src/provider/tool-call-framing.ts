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
 * Some servers leave it out of their `tool_calls` fragments, and a driver
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
 *
 * That last rule — an id-less fragment continues whichever call was most
 * recently active — only holds when one call is open at a time. A caller
 * that also calls {@link ToolCallIndexer.interleaving} before `indexOf` for
 * each fragment can detect the moment that stops being true.
 */
export class ToolCallIndexer {
	private readonly byId = new Map<string, number>()
	private readonly idOf = new Map<number, string>()
	private readonly named = new Set<number>()
	private latest: number | undefined
	private next = 0

	/** The index this fragment belongs to. */
	indexOf(delta: { readonly index?: number; readonly id?: string }): number {
		const index = hasIndex(delta.index) ? delta.index : this.placed(delta.id)
		if (delta.id && !this.byId.has(delta.id)) this.byId.set(delta.id, index)
		if (delta.id) {
			this.named.add(index)
			this.idOf.set(index, delta.id)
		}
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
	 * Whether placing this fragment now would leave a later id-less fragment
	 * with no way to be routed: see {@link ToolCallInterleaving}.
	 *
	 * Call BEFORE {@link indexOf} for the same fragment: `indexOf` moves
	 * "most recently active" onto the new call, so the call it would leave
	 * incomplete is only readable before that happens.
	 *
	 * `undefined` when there is nothing ambiguous about this fragment: it
	 * carries its own index (a real reuse of an index is
	 * {@link toolCallFramingViolation}'s job, not this one's), repeats an id
	 * already seen, names no id at all, or the call most recently active is
	 * unnamed (a fresh id then names THAT call, same as always) or already
	 * holds a complete JSON value, so nothing is left for an id-less
	 * fragment to ambiguously continue.
	 *
	 * `isComplete` is asked only for the call this could interleave with,
	 * and only when every cheaper check already passed — the caller's own
	 * notion of "parses as one JSON value, or is empty" (empty is a call
	 * with no arguments, not one still filling in).
	 */
	interleaving(
		delta: { readonly index?: number; readonly id?: string },
		isComplete: (index: number) => boolean,
	): ToolCallInterleaving | undefined {
		if (hasIndex(delta.index) || !delta.id || this.byId.has(delta.id)) return undefined
		if (this.latest === undefined || !this.named.has(this.latest)) return undefined
		if (isComplete(this.latest)) return undefined
		const openId = this.idOf.get(this.latest)
		if (!openId) return undefined
		return { kind: 'interleaved_without_index', openIndex: this.latest, openId, newId: delta.id }
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

/**
 * A stream that opened a new tool call by id, with no index of its own,
 * while the call most recently active also has no index and had not yet
 * accumulated a complete JSON value.
 *
 * {@link ToolCallIndexer.indexOf} places an id-less fragment on whichever
 * call was most recently active. That is right as long as only one call is
 * open at a time: a real LLM decodes its own output linearly, so a
 * compliant server sends one call's fragments to completion before another
 * call's id ever appears. Once a second call's id arrives while the first is
 * still incomplete, that guarantee is gone — a later id-less fragment could
 * continue either call, and there is no field in the fragment that says
 * which. Guessing (as `indexOf` alone used to) can splice one call's JSON
 * into the other's buffer.
 *
 * Detected the moment the second call opens, not only once an id-less
 * fragment actually arrives to prove the guess wrong: whether such a
 * fragment follows is exactly what cannot be known in advance, and code
 * shared across every driver must not bet on a compliant one never sending
 * it.
 */
export interface ToolCallInterleaving {
	readonly kind: 'interleaved_without_index'
	/** The index of the call that was still incomplete when the new one opened. */
	readonly openIndex: number
	readonly openId: string
	readonly newId: string
}

/** One sentence naming the interleaving, for an error's detail or log line. */
export function describeToolCallInterleaving(interleaving: ToolCallInterleaving): string {
	return `the stream opened tool call "${interleaving.newId}" with no index while call "${interleaving.openId}" (index ${interleaving.openIndex}) had not yet sent complete arguments and also carries no index, so a later fragment with neither could not be placed`
}

/**
 * The `ToolInputError.parseError` given to every call an interleaving names.
 * Reported `reason: 'malformed'`, never `'truncated'`: nothing here says the
 * response was cut off, and "the model moved on to more text, reasoning or
 * another call" — the only other case {@link ToolInputError} models — is
 * exactly what opening a second call means. The call left open may
 * genuinely have gone on to carry valid JSON, if by chance no id-less
 * fragment ever arrived for it; it is still reported unreadable rather than
 * risk having guessed right by luck on some other stream.
 */
export const INTERLEAVED_TOOL_INPUT_PARSE_ERROR =
	"its fragments arrived interleaved with another call's, with neither carrying an index to tell them apart"
