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

function hasIndex(index: number | undefined): index is number {
	return typeof index === 'number' && Number.isInteger(index) && index >= 0
}

/**
 * Whether a fragment carries neither an index nor an id — the one shape
 * `ToolCallIndexer.indexOf` cannot place by itself, and the only shape
 * {@link ToolCallIndexer.placeUnindexedFragment} is for. A fragment with
 * either goes through `indexOf` instead, unaffected by anything below.
 */
export function isUnindexedFragment(delta: {
	readonly index?: number
	readonly id?: string
}): boolean {
	return !hasIndex(delta.index) && !delta.id
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
 * A fragment that carries an id, with or without an index, is placed by
 * {@link indexOf}: an id seen before continues its call; a new id names the
 * call the latest fragment went to when that call has no id yet, and starts a
 * call on the next free index otherwise. A fragment that carries an index
 * keeps it, so a well-formed stream is read exactly as before and a real
 * reuse of an index is still refused.
 *
 * A fragment with NEITHER an id nor an index — see
 * {@link isUnindexedFragment} — goes through {@link placeUnindexedFragment}
 * instead, which is never a guess: nothing in such a fragment says which call
 * it continues, so the caller is asked, for every call opened so far,
 * whether it could still be receiving more of its arguments right now, and
 * the fragment is placed only when the answer says exactly one call.
 */
export class ToolCallIndexer {
	private readonly byId = new Map<string, number>()
	private readonly idOf = new Map<number, string>()
	private readonly named = new Set<number>()
	private readonly opened = new Set<number>()
	private latest: number | undefined
	private next = 0

	/** The index this id- or index-bearing fragment belongs to. */
	indexOf(delta: { readonly index?: number; readonly id?: string }): number {
		const index = hasIndex(delta.index) ? delta.index : this.placed(delta.id)
		if (delta.id && !this.byId.has(delta.id)) this.byId.set(delta.id, index)
		if (delta.id) {
			this.named.add(index)
			this.idOf.set(index, delta.id)
		}
		this.opened.add(index)
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
	 * Where a fragment with neither an id nor an index belongs — see
	 * {@link isUnindexedFragment}.
	 *
	 * Evaluated fresh for every such fragment, never decided once and
	 * remembered from when a call opened: a call's buffer can go from
	 * accepting more text to not (once it completes) and stay that way, so
	 * only the state right now, at each fragment, says which calls could
	 * still be its target. `canAccept(index)` is asked for every call opened
	 * so far and answers exactly that: true while its buffer is empty or is
	 * not yet a complete JSON value (it could still be receiving more), false
	 * once the buffer already parses as one complete value (nothing more is
	 * missing from it).
	 *
	 * - No call has opened yet: this fragment starts the first one. An id
	 *   for it, if the stream sends one, arrives on a later fragment and
	 *   attaches to it — the ordinary "arguments before the id" case,
	 *   unchanged.
	 * - Exactly one open call can still accept: it is unambiguously that
	 *   one.
	 * - Zero, or more than one, open call can: there is no way to tell which
	 *   one this fragment was for, or none could take it at all. Every call
	 *   that could have is returned in `candidates` (empty when none could),
	 *   and the fragment belongs to none of them — appending it to a guess
	 *   is exactly the splice this method exists to refuse.
	 */
	placeUnindexedFragment(
		canAccept: (index: number) => boolean,
	):
		| number
		| { readonly candidates: ReadonlyArray<{ readonly index: number; readonly id?: string }> } {
		if (this.opened.size === 0) {
			const index = this.next
			this.opened.add(index)
			this.next = index + 1
			this.latest = index
			return index
		}
		const candidates = [...this.opened].filter(canAccept)
		if (candidates.length === 1) {
			const [index] = candidates as [number]
			this.latest = index
			return index
		}
		return {
			candidates: candidates
				.sort((a, b) => a - b)
				.map((index) => ({ index, id: this.idOf.get(index) })),
		}
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

/** One sentence naming the violation, for an error's detail. */
export function describeToolCallFramingViolation(violation: ToolCallFramingViolation): string {
	return `the stream reused tool-call index ${violation.index} for call "${violation.newId}" while call "${violation.openId}" held it`
}

/**
 * A stream sent a fragment with neither an id nor an index while more than
 * one open call could still have been its target, or while none could.
 *
 * {@link ToolCallIndexer.placeUnindexedFragment} places such a fragment only
 * when exactly one open call can still accept more text right now (its
 * buffer empty, or not yet a complete JSON value). Once two calls are both
 * in that state — the ordinary shape of an OpenAI-style "open" fragment,
 * name and id with empty arguments, sent for one call right after another,
 * before either has streamed any argument text — a later fragment naming
 * neither could belong to either, and there is no field in it that says
 * which. Guessing (placing it on whichever call was merely most recently
 * active) can splice one call's JSON into the other's, and the splice can
 * still happen to parse, so the wrong call runs with no error at all.
 *
 * `candidates` names every call that could have accepted the fragment: more
 * than one when ambiguous, empty when the fragment matched no open call
 * (nothing to route it to, and nothing to blame for it either).
 */
export interface ToolCallInterleaving {
	readonly kind: 'interleaved_without_index'
	readonly candidates: ReadonlyArray<{ readonly index: number; readonly id?: string }>
}

/** One sentence naming the interleaving, for an error's detail or log line. */
export function describeToolCallInterleaving(interleaving: ToolCallInterleaving): string {
	if (interleaving.candidates.length === 0) {
		return 'the stream sent a tool-call fragment with neither an index nor an id, and no open call could still have accepted it'
	}
	const names = interleaving.candidates
		.map((c) => (c.id ? `"${c.id}"` : `index ${c.index} (not yet named)`))
		.join(' and ')
	return `the stream sent a tool-call fragment with neither an index nor an id while ${names} could each still have accepted it, with nothing to tell them apart`
}

/**
 * The `ToolInputError.parseError` given to every call an interleaving names.
 * Reported `reason: 'malformed'`, never `'truncated'`: nothing here says the
 * response was cut off, and "the model moved on to more text, reasoning or
 * another call" — the only other case {@link ToolInputError} models — is
 * exactly what opening a second call means. A call this leaves open may
 * genuinely have gone on to carry valid JSON, if by chance no ambiguous
 * fragment ever decided its fate; it is still reported unreadable rather
 * than risk having guessed right by luck on some other stream.
 */
export const INTERLEAVED_TOOL_INPUT_PARSE_ERROR =
	"its fragments arrived interleaved with another call's, with neither carrying an index to tell them apart"
