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

interface PlacedBlock {
	readonly text: string
	/** The history message this block follows; `undefined` for the start of the history. */
	after: Message | undefined
}

function textOf(message: Message): string {
	return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
}

/** A block whose own text says that a later one replaces it, under the name of what it reports. */
export interface ReplaceableBlock {
	readonly key: string
	readonly message: Message
}

/** How many superseded versions of a replaceable block still go with the latest. */
export const EARLIER_VERSIONS_KEPT = 2

interface VersionedBlock extends PlacedBlock {
	readonly message: Message
}

/**
 * Where a turn's request-only data sits, so it stays put from call to call.
 *
 * Request-only data is what the model needs for this request alone (a note
 * that something is unavailable, the running work). It
 * always goes at the tail of the history of the moment it first appears, never
 * ahead of the operator's message, and nothing about it is recorded. What a
 * step wants the model to keep reading in later requests is recorded as turn
 * context instead (`PrepareStepResult.recordedContext`).
 *
 * What a block says is the step's own business: a block it offers again with
 * the same text is the same block, and it keeps the place it first had; a
 * block it no longer offers is withdrawn, so corrected data never lingers. So
 * the requests of a turn share their opening up to the first block that
 * changed.
 *
 * A block that says of itself that a later one replaces it (the file
 * evidence) is never taken back. When its text changes, the earlier text stays
 * where it went and the new text follows the history of that moment, which is
 * how the block itself tells the model to read it; when it stops holding, a
 * short block says so. Only the latest version and the last
 * `EARLIER_VERSIONS_KEPT` before it are carried, and an earlier version whose
 * place a compaction rewrote is dropped, so the stale text stays small. Until
 * a version is dropped no request of the turn rewrites the one before it.
 *
 * One carry per turn. A position whose message has left the history (a
 * compaction rewrote it) is given up and the block follows the history.
 */
export class TurnContextCarry {
	private placed = new Map<string, PlacedBlock>()
	private readonly versions = new Map<string, VersionedBlock[]>()

	/**
	 * Put `blocks` and the `replaceable` ones into `request`, the projected copy
	 * of `history` (same length and order). `end` is the last message of the
	 * turn's own history. `retractions` says, per replaceable key, what to
	 * write when an earlier block of that key no longer holds.
	 */
	place(
		request: Message[],
		history: readonly Message[],
		end: Message | undefined,
		blocks: readonly Message[],
		replaceable: readonly ReplaceableBlock[] = [],
		retractions: Readonly<Record<string, Message>> = {},
	): void {
		const index = (message: Message | undefined) =>
			message ? history.lastIndexOf(message) : history.length - 1
		const positionOf = (slot: PlacedBlock) => index(slot.after) + 1
		const next = new Map<string, PlacedBlock>()
		const inserts: { at: number; message: Message }[] = []
		for (const message of blocks) {
			const text = textOf(message)
			if (next.has(text)) continue
			let slot: PlacedBlock | undefined = this.placed.get(text)
			if (slot) {
				if (slot.after && index(slot.after) < 0) slot = { text, after: end }
			} else {
				slot = { text, after: end }
			}
			next.set(text, slot)
			inserts.push({ at: positionOf(slot), message })
		}
		this.placed = next

		const offered = new Map(replaceable.map((block) => [block.key, block.message]))
		for (const key of new Set([...this.versions.keys(), ...offered.keys()])) {
			const held = this.versions.get(key) ?? []
			const wanted = offered.get(key) ?? retractions[key]
			const last = held.at(-1)
			if (wanted !== undefined && (last === undefined || last.text !== textOf(wanted)))
				held.push({ text: textOf(wanted), message: wanted, after: end })
			// An earlier version whose place a compaction rewrote is given up: the
			// request is rewritten at that point anyway, and stacking stale copies
			// at the end would only add bulk. The latest version is never given up.
			const kept = held.filter((version, i) => {
				if (i === held.length - 1) return true
				return !version.after || index(version.after) >= 0
			})
			// Only the latest and a few earlier versions are carried, so a long turn
			// does not grow by a full copy per change.
			kept.splice(0, Math.max(0, kept.length - (EARLIER_VERSIONS_KEPT + 1)))
			this.versions.set(key, kept)
			for (const version of kept) {
				if (version.after && index(version.after) < 0) version.after = end
				inserts.push({ at: positionOf(version), message: version.message })
			}
		}

		// Back to front, so an earlier position is not shifted by a later one;
		// blocks at one position keep the order they were offered in.
		const order = inserts.map((entry, position) => ({ ...entry, position }))
		order.sort((a, b) => b.at - a.at || b.position - a.position)
		for (const entry of order) request.splice(entry.at, 0, entry.message)
	}
}
