import { SPILL_MARKER } from '../runtime/query/tool-output-budget.js'
import { toolResultToText } from '../types/message/content.js'
import type { Message, ToolMessage, ToolResultBlock } from '../types/message/index.js'
import { findRetainedIndices } from './retention.js'

/**
 * Clear stale tool OUTPUT in place, without touching the conversation's
 * shape.
 *
 * Compaction was all-or-nothing: once the threshold hit, every older
 * message became a summary and the agent's own reasoning — the decisions,
 * the false starts it learned from, the exact wording of a plan — was
 * paraphrased away with it. That is a heavy price to pay for a context
 * problem that is usually caused by something much dumber: a handful of
 * enormous tool outputs the agent already read, extracted what it needed
 * from, and moved past.
 *
 * Clearing those reclaims most of the same tokens while preserving every
 * message verbatim. It is safe where trimming is not, because the `tool`
 * message stays exactly where it is with the same `toolCallId` — so the
 * `tool_use` ↔ `tool_result` pairing the providers require is untouched by
 * construction. The placeholder tells the model what happened, so a result
 * it turns out to still need is one tool call away rather than lost.
 */
export interface ToolResultEditConfig {
	/**
	 * How many of the most recent tool results to leave alone. The agent is
	 * usually still working with these, and clearing them buys tokens by
	 * forcing an immediate re-read — a net loss.
	 */
	readonly keepRecentToolResults?: number
	/**
	 * Don't bother clearing results smaller than this. Below it the
	 * placeholder is comparable in size to the output, so the churn buys
	 * nothing and costs the model a confusing hole in its history.
	 */
	readonly minCharsToClear?: number
	/** Tools whose output is never cleared, by name. */
	readonly preserveTools?: readonly string[]
}

export const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 3
export const DEFAULT_MIN_CHARS_TO_CLEAR = 1_000

/** Marks a cleared result, and is how a second pass recognizes its own work. */
const CLEARED_PREFIX = '[tool output cleared]'

/**
 * How much of the original result survives a clear, at each end.
 *
 * Small on purpose — the point of clearing is to reclaim context, and a
 * generous keep defeats it. But zero was the wrong number: a result just
 * over the minimum lost 100% of itself, including the three lines the
 * agent was actively reasoning from, to reclaim a few hundred characters.
 */
const KEEP_HEAD_CHARS = 400
const KEEP_TAIL_CHARS = 200

/**
 * Build the placeholder that replaces a cleared result.
 *
 * Two things survive, for two different reasons.
 *
 * The SPILL LINE, unconditionally: when a result was over the output
 * budget its full text was written to disk and that line is the pointer
 * back to it. Replacing the whole content destroyed the cheapest recovery
 * route precisely for the largest results — and then told the model to
 * call the tool again, which is advice to re-run something that returned
 * megabytes. Keeping one line preserves a `read`/`grep` route worth far
 * more than the line costs.
 *
 * A HEAD AND TAIL, because a result is not uniformly valuable: what a
 * model needs from a long output is usually near one end, and keeping a
 * few hundred characters of each is the difference between "I remember
 * roughly what this said" and "call it again".
 */
function clearedPlaceholder(
	content: ToolMessage['content'],
	toolName: string,
	size: number,
): string {
	const text = typeof content === 'string' ? content : toolResultToText(content)
	const parts: string[] = [
		`${CLEARED_PREFIX} ${toolName} returned ${size.toLocaleString('en-US')} characters, cleared to reclaim context.`,
	]

	const spillLine = text.split('\n').find((line) => line.startsWith(SPILL_MARKER))
	if (spillLine) {
		parts.push(
			spillLine,
			'Read a window of it with `read` (offset/limit) or search it with `grep`.',
		)
	} else {
		parts.push('Call the tool again if you still need the rest.')
	}

	if (text.length > KEEP_HEAD_CHARS + KEEP_TAIL_CHARS) {
		parts.push(
			'',
			text.slice(0, KEEP_HEAD_CHARS),
			`… ${(text.length - KEEP_HEAD_CHARS - KEEP_TAIL_CHARS).toLocaleString('en-US')} characters elided …`,
			text.slice(-KEEP_TAIL_CHARS),
		)
	} else {
		// Shorter than what an elision would keep, so eliding it would drop
		// content while saving nothing. A caller that lowered the minimum
		// far enough to reach a result this small gets it back whole, and a
		// truthful `charsReclaimed` of about zero — rather than a total loss
		// dressed up as a saving.
		parts.push('', text)
	}

	return parts.join('\n')
}

export interface ToolResultEditOutcome {
	readonly messages: Message[]
	readonly clearedCount: number
	/** Characters removed from the model-visible history. */
	readonly charsReclaimed: number
}

/**
 * One result cleared on its own, for a caller that chose it by some
 * other rule than staleness. The same placeholder, the same accounting.
 */
export function clearToolResult(
	tool: ToolMessage,
	toolName: string,
): { readonly message: ToolMessage; readonly charsReclaimed: number } {
	const size = measureContent(tool.content)
	const content = clearedPlaceholder(tool.content, toolName, size)
	return { message: { ...tool, content }, charsReclaimed: Math.max(0, size - content.length) }
}

export function isClearedToolResult(content: unknown): boolean {
	return typeof content === 'string' && content.startsWith(CLEARED_PREFIX)
}

/**
 * Replace the output of old, large tool results with a short placeholder.
 *
 * Returns a NEW array; the input is not mutated. `clearedCount === 0` means
 * nothing was eligible, and the caller should fall through to whatever it
 * would have done anyway.
 */
export function clearStaleToolResults(
	messages: readonly Message[],
	config: ToolResultEditConfig = {},
): ToolResultEditOutcome {
	const keepRecent = Math.max(0, config.keepRecentToolResults ?? DEFAULT_KEEP_RECENT_TOOL_RESULTS)
	const minChars = Math.max(0, config.minCharsToClear ?? DEFAULT_MIN_CHARS_TO_CLEAR)
	const preserve = new Set(config.preserveTools ?? [])

	// Which tool call produced which result, so a preserve-list can be
	// written in terms of TOOL NAMES — the only handle a host actually has.
	const toolNameByCallId = new Map<string, string>()
	for (const msg of messages) {
		if (msg.role !== 'assistant' || !msg.toolCalls) continue
		for (const call of msg.toolCalls) {
			toolNameByCallId.set(call.id, call.function.name)
		}
	}

	const toolIndices: number[] = []
	messages.forEach((msg, index) => {
		if (msg.role === 'tool') toolIndices.push(index)
	})

	// `slice(-0)` returns the WHOLE array, so a plain `slice(-keepRecent)`
	// would protect EVERY result when the caller asked to protect none.
	const protectedFromEnd = new Set(keepRecent === 0 ? [] : toolIndices.slice(-keepRecent))

	// A pinned result is pinned against THIS too. Clearing keeps the message
	// and replaces its content, which is exactly the loss `retain` was asked
	// to prevent — a placeholder where the account id used to be reads as an
	// answer, not as an omission.
	const retained = findRetainedIndices(messages)

	let clearedCount = 0
	let charsReclaimed = 0

	const edited = messages.map((msg, index) => {
		if (msg.role !== 'tool') return msg
		if (protectedFromEnd.has(index)) return msg
		if (retained.has(index)) return msg

		const tool = msg as ToolMessage
		// An error result is small and it STEERS — it is the thing the model
		// reads to decide what to do differently. Clearing it would reclaim
		// nothing and remove the reason a later turn makes sense.
		if (tool.isError) return msg
		if (isClearedToolResult(tool.content)) return msg

		const toolName = toolNameByCallId.get(tool.toolCallId) ?? 'unknown'
		if (preserve.has(toolName)) return msg

		const size = measureContent(tool.content)
		if (size < minChars) return msg

		clearedCount++
		charsReclaimed += size - 0
		return {
			...tool,
			content: clearedPlaceholder(tool.content, toolName, size),
		} satisfies ToolMessage
	})

	// Subtract what the placeholders themselves cost, so the number a
	// caller uses to decide "was that enough?" is the real saving and not
	// an overstatement.
	if (clearedCount > 0) {
		let placeholderChars = 0
		for (const msg of edited) {
			if (msg.role === 'tool' && isClearedToolResult(msg.content)) {
				placeholderChars += measureContent(msg.content)
			}
		}
		charsReclaimed = Math.max(0, charsReclaimed - placeholderChars)
	}

	return { messages: edited, clearedCount, charsReclaimed }
}

/**
 * Size of a tool result as the model sees it.
 *
 * An image block is measured by its base64 payload, which is the whole
 * point: a screenshot is the single largest thing a tool result can carry,
 * and it is exactly the kind of output an agent reads once and never
 * needs again.
 */
function measureContent(content: ToolMessage['content']): number {
	if (typeof content === 'string') return content.length
	if (!Array.isArray(content)) return 0
	let total = 0
	for (const block of content as readonly ToolResultBlock[]) {
		if (block.type === 'text') total += block.text.length
		else if (block.type === 'image') total += block.data.length
	}
	return total
}
