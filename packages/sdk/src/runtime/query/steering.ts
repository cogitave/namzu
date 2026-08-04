import type { Message } from '../../types/message/index.js'

/**
 * Guidance a host hands to a turn that is already running.
 *
 * The gap this closes is narrow and was documented rather than fixed:
 * `AgentManager` has had `queueMessage` / `drainMessages` for a while, and
 * nothing in the iteration loop ever read them — the type says so in as many
 * words. So a host watching a run go the wrong way had two options, and both
 * are worse than they sound. Cancel and start over throws away every tool
 * result the run had already paid for. Reject through the review gate only
 * works if a tool call happens to be pending approval, and it says "no" when
 * the host wanted to say "yes, but look at this first".
 *
 * **Why the text rides on a tool result rather than arriving as a user
 * message.** A `tool_use` block must be answered by a `tool_result` with the
 * same id — providers reject a user turn wedged between them — so there is no
 * legal place to insert a message mid-batch at all. The slot that already
 * exists is the tool result itself, and this codebase had already worked that
 * out for a neighbouring case: a denied call carries its reason INSIDE the
 * `tool_result`, and `executor.ts` notes that this is also what makes a
 * rejection *steer*, because the model reads it in the slot it already
 * attends to for tool outcomes. Steering is the same delivery with the
 * refusal removed.
 *
 * **What it deliberately is not.** It does not interrupt. The batch in flight
 * finishes, and the guidance lands where the model looks next. A host that
 * wants the current work stopped wants `AbortSignal`, which is a different
 * question with a different answer — and conflating the two is how "please
 * also check the tests" ends up killing a half-written file.
 */
export interface SteeringChannel {
	/**
	 * Queue guidance for the running turn.
	 *
	 * Repeated calls before the next drain accumulate in order rather than
	 * replacing each other: two corrections typed a second apart are two
	 * things the model should see, and keeping only the last one silently
	 * discards a host's instruction.
	 *
	 * Empty and whitespace-only text is ignored, so a stray keystroke does
	 * not append a blank line to a tool result.
	 */
	steer(text: string): void

	/** Take everything queued, leaving the channel empty. */
	drain(): string | undefined

	/** True while guidance is queued and undelivered. */
	readonly pending: boolean
}

export class SteeringBinding implements SteeringChannel {
	private queued: string[] = []

	steer(text: string): void {
		const trimmed = text.trim()
		if (!trimmed) return
		this.queued.push(trimmed)
	}

	drain(): string | undefined {
		if (this.queued.length === 0) return undefined
		const joined = this.queued.join('\n')
		this.queued = []
		return joined
	}

	get pending(): boolean {
		return this.queued.length > 0
	}
}

/**
 * The frame the guidance arrives in.
 *
 * Labelled because the model is being handed text from a party other than the
 * tool whose result it is reading, in that tool's slot. Unlabelled, it reads
 * as something the tool said — so a steer saying "stop and ask me first" would
 * look like output from `bash`.
 *
 * This is NOT the untrusted-content envelope. The host operating the run is
 * the one party whose words the agent SHOULD act on; framing them as material
 * to be worked with rather than followed would inverting the very thing the
 * host is trying to do. Different party, different frame, on purpose.
 */
export function formatSteeringNote(text: string): string {
	return `\n\n[Message from the operator, received while this tool was running]\n${text}`
}

/**
 * Append the guidance to the last tool result in a settled batch.
 *
 * The LAST one, so it is the final thing the model reads before deciding what
 * to do next — appending to the first would bury it under every later result.
 *
 * Returns the messages unchanged when there is nothing queued, and when the
 * batch carries no tool result to attach to. The second case is not a failure
 * to handle: a turn that called no tools has nothing in flight, so guidance
 * belongs to the next turn and stays queued for it.
 */
export function attachSteering(
	messages: readonly Message[],
	channel: SteeringChannel | undefined,
): readonly Message[] {
	if (!channel?.pending) return messages

	let lastToolIndex = -1
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === 'tool') {
			lastToolIndex = index
			break
		}
	}
	if (lastToolIndex === -1) return messages

	const guidance = channel.drain()
	if (guidance === undefined) return messages

	const target = messages[lastToolIndex] as Message
	// Only text is extended. A tool that answered with structured content —
	// an image block, say — has a shape the model reads positionally, and
	// appending a string to it would either be dropped or corrupt the block.
	// Such a result keeps its content and the note follows it as its own text
	// part where the shape allows, and otherwise the guidance stays queued
	// for the next turn rather than being forced into a slot it does not fit.
	if (typeof target.content !== 'string') {
		channel.steer(guidance)
		return messages
	}

	const next = [...messages]
	next[lastToolIndex] = { ...target, content: target.content + formatSteeringNote(guidance) }
	return next
}
