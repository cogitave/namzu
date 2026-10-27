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

/**
 * Where a turn's request-only data sits, so it stays put from call to call.
 *
 * Request-only data is what the model needs for this request alone (a note
 * that something is unavailable, the work still running). It always goes at
 * the tail of the history of the moment it first appears, never ahead of the
 * operator's message, and nothing about it is recorded. What a step wants the
 * model to keep reading in later requests is recorded as turn context instead
 * (`PrepareStepResult.recordedContext`), and what the loop learns about files
 * and finished work is recorded the same way.
 *
 * What a block says is the step's own business: a block it offers again with
 * the same text is the same block, and it keeps the place it first had; a
 * block it no longer offers is withdrawn, so corrected data never lingers. So
 * the requests of a turn share their opening up to the first block that
 * changed.
 *
 * One carry per turn. A position whose message has left the history (a
 * compaction rewrote it) is given up and the block follows the history.
 */
export class TurnContextCarry {
	private placed = new Map<string, PlacedBlock>()

	/**
	 * Put `blocks` into `request`, the projected copy of `history` (same
	 * length and order). `end` is the last message of the turn's own history.
	 * Blocks at one position keep the order they were offered in, so an entry
	 * the loop has just recorded, offered last, sits where it will sit in the
	 * history of the next request.
	 */
	place(
		request: Message[],
		history: readonly Message[],
		end: Message | undefined,
		blocks: readonly Message[],
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

		// Back to front, so an earlier position is not shifted by a later one;
		// blocks at one position keep the order they were offered in.
		const order = inserts.map((entry, position) => ({ ...entry, position }))
		order.sort((a, b) => b.at - a.at || b.position - a.position)
		for (const entry of order) request.splice(entry.at, 0, entry.message)
	}
}
