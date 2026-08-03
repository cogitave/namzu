import type { Message } from '../types/message/index.js'
import { findSafeTrimIndex } from './dangling.js'
import { findRetainedIndices } from './retention.js'

/**
 * Why the runtime is asking for a shorter history.
 *
 * The two cases want different behaviour and a reducer that cannot tell
 * them apart has to guess. `'threshold'` is speculative — the estimate says
 * the window is filling, nothing has failed, and declining costs only some
 * headroom. `'overflow'` is the provider having already rejected the
 * prompt: declining there ends the run.
 */
export type ContextReductionReason = 'threshold' | 'overflow'

/** Everything a reducer needs to decide, and nothing it cannot act on. */
export interface ContextReduction {
	/** The live history, oldest first. Treat as read-only and return a new array. */
	readonly messages: readonly Message[]
	readonly reason: ContextReductionReason
	/** Estimated size of `messages`. Derived from the provider's last prompt count when there is one, else measured. */
	readonly estimatedTokens: number
	/** What it has to fit in. Resolved from the model when the host did not say. */
	readonly contextWindowTokens: number
	/** The model this run is calling, for a reducer that varies by model. */
	readonly model: string
	/** The run's configured recent-window size, as a starting point. */
	readonly keepRecentMessages: number
}

/**
 * Replace the run's history with a shorter one.
 *
 * Returning `undefined` means "I could not shorten this" and is a first-class
 * answer, not a failure — on `'threshold'` the run simply continues, and on
 * `'overflow'` it fails with an irreducible-prompt error instead of retrying
 * a prompt nothing changed. That is deliberate: a reducer that returned the
 * input unchanged while reporting success would send the same rejected
 * prompt again and burn a call to learn the same thing.
 *
 * A reducer OWNS reduction for the run it governs. The built-in structured
 * pass — LLM-verified summarization, stale tool-result clearing, working
 * state slots — does not also run, because two mechanisms editing the same
 * history in one pass cannot both be reasoned about.
 *
 * Invariants a reducer is expected to keep, all three enforced by the
 * built-in one and none of them checkable from here:
 *
 * 1. The leading system messages stay. They carry the system prompt and the
 *    working-memory slot; dropping them changes who the agent is.
 * 2. `tool_use` and its `tool_result` stay together. A split pair is a 400
 *    from the provider, so a reducer that splits one turns a context problem
 *    into a dead run. {@link findSafeTrimIndex} is exported for this.
 * 3. Messages marked `retain` survive. That marker is how a caller says a
 *    fact in the middle of the conversation outranks recency.
 */
export type ContextReducer = (
	reduction: ContextReduction,
) => readonly Message[] | undefined | Promise<readonly Message[] | undefined>

export interface SlidingWindowOptions {
	/**
	 * How many trailing messages to keep. Defaults to the run's configured
	 * `keepRecentMessages`, so the same knob governs both strategies.
	 */
	readonly keepRecentMessages?: number

	/**
	 * Fraction of the window to keep when relieving an overflow, applied to
	 * the recent count. Defaults to 0.5.
	 *
	 * An overflow means the ordinary window was already too big, so cutting
	 * to the same size again would shed nothing and the caller would retry
	 * an identical prompt.
	 */
	readonly overflowFactor?: number
}

/**
 * Keep the last N turns, drop what precedes them, summarize nothing.
 *
 * The honest counterpart to the structured strategy rather than a lesser
 * version of it. Structured compaction pays a summarization call and
 * paraphrases the agent's own reasoning to buy context; this pays nothing
 * and admits the older history is gone. For a long-running agent whose
 * state lives outside the transcript — a task queue, a file it keeps
 * editing, a working-memory block the host renders each turn — that is the
 * better trade, and the paraphrase was only ever cost.
 *
 * Until now `strategy: 'sliding-window'` was accepted by the config schema
 * and then ignored: the runtime asked only whether the strategy was
 * `'disabled'`, so choosing the cheap non-LLM path silently ran the
 * expensive LLM one. This is the implementation that name always claimed.
 */
export function createSlidingWindowReducer(options: SlidingWindowOptions = {}): ContextReducer {
	const factor = options.overflowFactor ?? 0.5

	return ({ messages, reason, keepRecentMessages }) => {
		const configured = options.keepRecentMessages ?? keepRecentMessages
		const keep =
			reason === 'overflow' ? Math.max(1, Math.floor(configured * factor)) : Math.max(1, configured)

		let leadingSystem = 0
		while (messages[leadingSystem]?.role === 'system') leadingSystem++

		const naive = messages.length - keep
		if (naive <= leadingSystem) return undefined

		// `findSafeTrimIndex` moves a cut forward until the kept tail is a
		// history a provider will accept — no `tool_result` without its
		// `tool_use`, and never opening on an assistant turn, because the tail
		// becomes the start of the wire conversation once the older half is
		// gone. So a candidate is safe exactly when it is already its own
		// answer.
		//
		// Walk BACKWARDS first: that lands on the safe cut nearest the
		// requested window, keeping a little more than asked rather than a lot
		// less.
		const trimmable = [...messages]
		let cut = -1
		for (let candidate = naive; candidate > leadingSystem; candidate--) {
			if (findSafeTrimIndex(trimmable, candidate) === candidate) {
				cut = candidate
				break
			}
		}

		// Nothing safe below the request. Take the answer ABOVE it instead of
		// refusing: in a multi-step turn — the agent working through tool calls
		// with the user silent — every boundary in the recent window lands on
		// an assistant or tool message, so a backwards-only search declines
		// exactly when the history is longest and shedding matters most. The
		// forward cut keeps less than asked, which is a smaller history than
		// the caller wanted but still a correct one.
		if (cut < 0) {
			const forward = findSafeTrimIndex(trimmable, naive)
			// `messages.length` means "keep nothing", which is not a history.
			if (forward > leadingSystem && forward < messages.length) cut = forward
		}
		if (cut < 0) return undefined

		const retained = findRetainedIndices(messages)
		const survivors: Message[] = []
		for (let i = 0; i < messages.length; i++) {
			const message = messages[i]
			if (!message) continue
			if (i < leadingSystem || i >= cut || retained.has(i)) survivors.push(message)
		}

		// Nothing went. Reporting that as a reduction would have the overflow
		// path retry an identical prompt.
		return survivors.length === messages.length ? undefined : survivors
	}
}
