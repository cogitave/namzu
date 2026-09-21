import { renderPins } from '../../../../compaction/serializer.js'
import { NAMZU } from '../../../../constants/telemetry/index.js'
import { type Message, createSystemMessage } from '../../../../types/message/index.js'
import { stepContextMessage } from '../step-context.js'
import type { IterationContext } from './context.js'

/**
 * Sentinel header identifying the single PINNED working-memory system message.
 *
 * The SDK finds + replaces the slot by this header every turn and uses the same
 * identity to re-pin it if compaction ever drops it (the OPAQUE survival guard
 * in `compaction.ts` — no host-format knowledge required). The host's rendered
 * block is stored verbatim AFTER this header; the SDK never parses it.
 */
export const WORKING_MEMORY_HEADER =
	'[WORKING MEMORY] Authoritative state for this conversation — you produced these.'

// Stored in the message, so ownership survives checkpoint JSON. Unmarked
// inherited blocks may be opaque host ledgers and must never be guessed away.
const TOOL_PINS_HEADER = `${WORKING_MEMORY_HEADER}\n[Tool-managed pins]`

/**
 * True when `content` is the pinned working-memory slot (header identity only).
 * Shared with `compaction.ts` so the survival guard re-pins by the SAME rule.
 */
export function isWorkingMemoryMessage(content: string | null | undefined): boolean {
	return typeof content === 'string' && content.startsWith(WORKING_MEMORY_HEADER)
}

/** Index of the pinned slot inside the leading system run, or -1. */
function workingMemoryIndex(msgs: readonly Message[]): number {
	// Bound the search to the LEADING system run (the compaction-preserved
	// region). A working-memory header appearing later in the transcript (e.g.
	// echoed by a tool result) must not be mistaken for the pinned slot.
	for (let i = 0; i < msgs.length; i++) {
		const m = msgs[i]
		if (m?.role !== 'system') return -1
		if (isWorkingMemoryMessage(m.content)) return i
	}
	return -1
}

/**
 * Split the pinned slot out of a request's history.
 *
 * The slot keeps its place in the RUN's history, where compaction preserves
 * it. The REQUEST carries it as request-only context instead: a runtime
 * context message of kind `step-context`, after the history, holding the
 * slot's content verbatim under the same "runtime-generated; not a new user
 * request" label every other step-context message carries — so the header
 * begins the message's second line, not its first. The slot changes whenever a pin does, and a
 * driver that hoists system messages ahead of the conversation (one that
 * renders tools, then system, then messages) would otherwise invalidate the
 * cached conversation prefix on every such change. Every driver keeps
 * request-only context after history, and a caching driver ends its
 * breakpoint before it.
 *
 * Returns the input array unchanged, and no context, when there is no slot.
 */
export function splitWorkingMemoryForRequest(messages: readonly Message[]): {
	readonly history: readonly Message[]
	readonly context?: Message
} {
	const idx = workingMemoryIndex(messages)
	const slot = idx >= 0 ? messages[idx] : undefined
	if (!slot || typeof slot.content !== 'string') return { history: messages }
	return {
		history: [...messages.slice(0, idx), ...messages.slice(idx + 1)],
		context: stepContextMessage(slot.content),
	}
}

/**
 * Resolve the host's working-memory string and rewrite a single PINNED leading
 * system message in place. Insert-or-replace keyed by {@link WORKING_MEMORY_HEADER};
 * an empty/blank string removes the slot.
 *
 * The slot is an EPHEMERAL system message placed as the LAST leading system
 * message (after the cached static + dynamic system messages), so it rides
 * inside the compaction-preserved leading-system run. That is its place in
 * the run's HISTORY only: a request carries it as request-only context after
 * the history ({@link splitWorkingMemoryForRequest}), so a changed pin never
 * busts the cached conversation prefix.
 *
 * Failure-isolated (the `web-search` seam rule): a throwing/slow provider
 * degrades to "no refresh this turn" (keeps the prior slot), never breaks the
 * run. With no provider or tool-owned slot, the history is left unchanged.
 */
export async function refreshWorkingMemory(ctx: IterationContext): Promise<void> {
	const provider = ctx.workingMemoryProvider
	// What the tools pinned joins the slot beside what the host provides: a
	// pin exists to be in front of the model every iteration, and until this
	// the working state reached the history only through a compaction
	// summary. When the final pin is removed, retire only a tool-owned slot.
	const pinned = ctx.workingStateManager ? renderPins(ctx.workingStateManager.getState()) : null

	let block = ''
	if (provider) {
		try {
			block =
				(await provider({
					turnId: ctx.recorder.turnId,
					iteration: ctx.recorder.currentIteration,
				})) ?? ''
		} catch (err) {
			ctx.log.warn('workingMemoryProvider failed; keeping prior slot', {
				[NAMZU.TURN_ID]: ctx.recorder.turnId,
				'exception.message': err instanceof Error ? err.message : String(err),
			})
			return
		}
	}
	if (pinned) block = block.trim() ? `${block.trim()}\n\n${pinned}` : pinned

	const msgs = ctx.recorder.messages

	let leadEnd = 0
	while (leadEnd < msgs.length && msgs[leadEnd]?.role === 'system') leadEnd++
	const idx = workingMemoryIndex(msgs)

	if (!provider && !pinned) {
		if (!ctx.workingStateManager) return
		const prior = msgs[idx]?.content
		if (typeof prior !== 'string' || !prior.startsWith(TOOL_PINS_HEADER)) return
	}

	if (!block.trim()) {
		// Empty block ⇒ remove the slot (byte-identical-when-empty).
		if (idx >= 0) {
			msgs.splice(idx, 1)
			ctx.recorder.clearLastPromptTokens?.()
		}
		return
	}

	const header = provider ? WORKING_MEMORY_HEADER : TOOL_PINS_HEADER
	const content = `${header}\n\n${block}`
	if (idx >= 0 && msgs[idx]?.content === content) return
	const wm = createSystemMessage(content, 'ephemeral')
	if (idx >= 0) {
		msgs[idx] = wm
	} else {
		// Insert as the LAST leading system message (after static + dynamic).
		msgs.splice(leadEnd, 0, wm)
	}
	// The old provider reading measured a different prefix, and an insertion
	// also moves its tail watermark. Re-estimate until the next request reports.
	ctx.recorder.clearLastPromptTokens?.()
}
