import { createRuntimeContextMessage } from '../../../types/message/index.js'
import type { Message } from '../../../types/message/index.js'
import { isOperatorUserMessage } from '../steering.js'

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

/**
 * Put `blocks` in front of the operator's new message when that message is
 * what the model is about to answer, so the request is the last thing it
 * reads and the longest data comes before it. Only the reminders and other
 * request-only context may follow that message: once the turn has an
 * assistant or tool message after it, the blocks stay at the end of the
 * history, where a caching driver ends its breakpoint before them, so the
 * tool loop of a long turn is not re-read at full price on every step.
 *
 * Reminders and notices that follow the operator's message stay where they
 * are: they are short, and the edge after the request is where they are read.
 */
export function placeBeforeLatestOperatorMessage(history: Message[], blocks: readonly Message[]) {
	if (blocks.length === 0) return
	let at = history.length
	for (let i = history.length - 1; i >= 0; i--) {
		const message = history[i] as Message
		if (isOperatorUserMessage(message)) {
			at = i
			break
		}
		// A reply or a tool result after the message: the model has moved on.
		if (message.role === 'assistant' || message.role === 'tool') break
	}
	history.splice(at, 0, ...blocks)
}

interface PlacedBlock {
	readonly text: string
	/** The operator message this block precedes, or the history message it follows. */
	readonly at: { readonly before: Message } | { readonly after: Message | undefined }
}

function textOf(message: Message): string {
	return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
}

/** The operator message the model is about to answer, when there is one. */
function pendingOperatorMessage(history: readonly Message[]): Message | undefined {
	for (let i = history.length - 1; i >= 0; i--) {
		const message = history[i] as Message
		if (isOperatorUserMessage(message)) return message
		if (message.role === 'assistant' || message.role === 'tool') return undefined
	}
	return undefined
}

/**
 * Where a turn's request-only data sits, so it stays put from call to call.
 *
 * What a block says is the step's own business: a block it offers again with
 * the same text is the same block, and it keeps the place it first had; a
 * block it no longer offers is withdrawn, so corrected data never lingers.
 * A block seen for the first time goes before the operator's message when that
 * message is what the model is answering, and otherwise after the history of
 * that moment. So the requests of a turn share their opening up to the first
 * block that changed, and a caching driver keeps reading the same prefix
 * instead of re-reading the turn from the operator's message on.
 *
 * One carry per turn. A position whose message has left the history (a
 * compaction rewrote it) is given up and the block follows the history.
 */
export class TurnContextCarry {
	private placed = new Map<string, PlacedBlock>()

	/**
	 * Put `blocks` into `request`, the projected copy of `history` (same
	 * length and order). `end` is the last message of the turn's own history.
	 */
	place(
		request: Message[],
		history: readonly Message[],
		end: Message | undefined,
		blocks: readonly Message[],
	): void {
		const index = (message: Message | undefined) =>
			message ? history.lastIndexOf(message) : history.length - 1
		const operator = pendingOperatorMessage(history)
		const next = new Map<string, PlacedBlock>()
		const inserts: { at: number; message: Message }[] = []
		for (const message of blocks) {
			const text = textOf(message)
			if (next.has(text)) continue
			let slot: PlacedBlock | undefined = this.placed.get(text)
			if (slot) {
				const anchor = 'before' in slot.at ? slot.at.before : slot.at.after
				if (anchor && index(anchor) < 0) slot = { text, at: { after: end } }
			} else {
				slot = { text, at: operator ? { before: operator } : { after: end } }
			}
			next.set(text, slot)
			inserts.push({
				at: 'before' in slot.at ? index(slot.at.before) : index(slot.at.after) + 1,
				message,
			})
		}
		this.placed = next
		// Back to front, so an earlier position is not shifted by a later one;
		// blocks at one position keep the order they were offered in.
		const order = inserts.map((entry, position) => ({ ...entry, position }))
		order.sort((a, b) => b.at - a.at || b.position - a.position)
		for (const entry of order) request.splice(entry.at, 0, entry.message)
	}
}
