import type { CompactionConfig } from '../config/runtime.js'
import { CHARS_PER_TOKEN } from '../constants/limits.js'
import type { Message } from '../types/message/index.js'
import { findSafeTrimIndex } from './dangling.js'
import { buildGoal } from './salience/goal.js'
import { scoreMessages } from './salience/score.js'
import { type WorkingSetPlan, planWorkingSet } from './salience/working-set.js'
import { clearStaleToolResults } from './tool-result-editing.js'

/**
 * The compaction decision, with no run attached.
 *
 * The whole algorithm — the leading-system floor scan, the tool-result
 * pre-pass, the boundary search, the guards — lived inside
 * `runCompactionCheck` and read everything off the iteration context — the
 * live message array, the logger, the event emitter, the working-state
 * manager. Nothing outside a live iteration could run it, so the pass was
 * testable only through a full run harness and unreachable from any
 * host-callable entry point.
 *
 * This file therefore holds NO reference to that context, and a test greps
 * for one: reintroducing a single field read would quietly re-couple the
 * arithmetic to a run and nothing else would fail.
 *
 * What stayed behind is everything with an effect: the model call, the
 * working-memory re-pin, the array install, the logging, every
 * `emitEvent`. What moved here is the arithmetic. The split is the
 * question "what should happen" separated from "make it happen", and only
 * the first half can be asked without a run.
 */

/** Why a pass decided to do nothing. */
export type CompactionSkipReason =
	/** Fewer messages than the recent window plus a floor — nothing to move. */
	| 'too_few_messages'
	/** An in-run pass has no leading `system` message to use as its permanent floor. */
	| 'no_system_floor'
	/** Every candidate boundary would split a tool-call pair. */
	| 'no_safe_cut'
	/** A safe cut exists but leaves nothing older worth summarising. */
	| 'too_few_older'

export type CompactionPlan =
	| { readonly kind: 'skip'; readonly reason: CompactionSkipReason }
	| {
			readonly kind: 'cleared'
			readonly messages: readonly Message[]
			readonly clearedCount: number
			/** Assistant narrations cut to their first sentence by the salience pass. */
			readonly stubbedCount?: number
			readonly charsReclaimed: number
			readonly reclaimedTokens: number
			readonly reliefWasEnough: boolean
	  }
	| {
			readonly kind: 'plan'
			readonly systemMessages: readonly Message[]
			readonly olderMessages: readonly Message[]
			readonly recentMessages: readonly Message[]
			readonly keepStart: number
	  }

export interface CompactionPlanInput {
	readonly messages: readonly Message[]
	readonly config: CompactionConfig
	readonly contextWindowTokens: number
	readonly estimatedTokens: number
	readonly force?: boolean
	/**
	 * Let a host-created pass establish its own retained summary floor.
	 *
	 * This is deliberately separate from `force`: a provider overflow can
	 * force the threshold decision without changing the live run's prompt
	 * invariant, while a host may own a durable user/assistant-only history
	 * that has no system floor yet.
	 */
	readonly allowNoSystemFloor?: boolean
	/**
	 * Skip the tool-result pre-pass and go straight to the boundary search.
	 *
	 * The two steps are sequential in a real pass: ask once for a cleared
	 * candidate and, if that was not enough relief, ask again for a cut over
	 * that candidate. The caller need not install the first answer before the
	 * second question. In fact the live runtime deliberately stages an
	 * insufficient clear until summary verification succeeds, then publishes
	 * the combined edit atomically. Returning both from one call would mean
	 * nesting a union inside a union and computing a boundary the caller may
	 * never use; asking twice says what is happening without prescribing when
	 * an effect becomes visible.
	 */
	readonly skipToolResultClear?: boolean
}

/**
 * How many characters a message's content is worth.
 *
 * An image costs far fewer tokens than its base64 length divided by four —
 * but under-counting it to zero is the worse error: it let a run full of
 * screenshots read as an empty context.
 */
function measureContentChars(content: unknown): number {
	if (typeof content === 'string') return content.length
	if (!Array.isArray(content)) return 0
	let total = 0
	for (const block of content as readonly Record<string, unknown>[]) {
		if (block.type === 'text' && typeof block.text === 'string') total += block.text.length
		else if (block.type === 'image' && typeof block.data === 'string') total += block.data.length
	}
	return total
}

/**
 * The last index whose tail fits in `budgetTokens`, walking backwards.
 *
 * Replaces the naive count boundary and nothing else — the caller runs the
 * existing `findSafeTrimIndex` search downward from whatever this returns,
 * so the `tool_use` ↔ `tool_result` pairing guarantee is untouched by
 * construction rather than by care.
 *
 * Floored at one message. A single final message larger than the whole
 * budget still has to be kept: it is the live turn, and dropping it to
 * satisfy a size preference would delete the thing the run is answering.
 *
 * Exported for its own tests. There used to be a second copy of this in the
 * phase file with a `__forTests` export beside it; two implementations of
 * one boundary calculation is the failure this extraction exists to end, so
 * the phase's copy is gone and its tests point here.
 */
export function naiveKeepStartByTokens(messages: readonly Message[], budgetTokens: number): number {
	let tokens = 0
	let start = messages.length
	for (let index = messages.length - 1; index >= 0; index--) {
		const cost = Math.ceil(measureContentChars(messages[index]?.content) / CHARS_PER_TOKEN)
		// Checked BEFORE adding, so the boundary never includes a message
		// that pushes the tail over. Adding first and trimming after would
		// admit one oversized message on every run.
		if (start < messages.length && tokens + cost > budgetTokens) break
		tokens += cost
		start = index
	}
	return start
}

/**
 * The salience pass: score every message and evict the least salient
 * until the context is under `softTarget`. Returned as a `cleared` plan
 * so the phase commits it the way it commits the stale-result pass; the
 * summary path runs after it only when the trigger threshold is still
 * exceeded.
 */
/** Where the salience pass holds the context, as a fraction of the window. */
export const DEFAULT_SOFT_TARGET = 0.5

export function planSalienceWorkingSet(input: {
	readonly messages: readonly Message[]
	readonly config: CompactionConfig
	readonly contextWindowTokens: number
	readonly estimatedTokens: number
	readonly openTasks?: readonly string[]
}): Extract<CompactionPlan, { kind: 'cleared' }> & { readonly working: WorkingSetPlan } {
	const { config, estimatedTokens, contextWindowTokens: budget } = input
	const goal = buildGoal(input.messages, {
		...(input.openTasks ? { openTasks: input.openTasks } : {}),
	})
	const scored = scoreMessages(input.messages, {
		goal,
		keepRecentMessages: config.keepRecentMessages,
	})
	const working = planWorkingSet(input.messages, scored, {
		estimatedTokens,
		targetTokens: Math.floor(budget * (config.softTarget ?? DEFAULT_SOFT_TARGET)),
		minToolResultChars: config.minToolResultCharsToClear,
		...(config.preserveToolResultsFrom ? { preserveTools: config.preserveToolResultsFrom } : {}),
	})
	return {
		kind: 'cleared',
		messages: working.messages,
		clearedCount: working.clearedCount,
		stubbedCount: working.stubbedCount,
		charsReclaimed: working.charsReclaimed,
		reclaimedTokens: working.reclaimedTokens,
		reliefWasEnough: (estimatedTokens - working.reclaimedTokens) / budget < config.triggerThreshold,
		working,
	}
}

export function planCompaction(input: CompactionPlanInput): CompactionPlan {
	const { config, estimatedTokens, contextWindowTokens: budget } = input

	if (!input.skipToolResultClear && config.clearToolResults !== false) {
		const edit = clearStaleToolResults(input.messages, {
			...(config.keepRecentToolResults !== undefined
				? { keepRecentToolResults: config.keepRecentToolResults }
				: {}),
			...(config.minToolResultCharsToClear !== undefined
				? { minCharsToClear: config.minToolResultCharsToClear }
				: {}),
			...(config.preserveToolResultsFrom ? { preserveTools: config.preserveToolResultsFrom } : {}),
		})

		if (edit.clearedCount > 0) {
			const reclaimedTokens = Math.ceil(edit.charsReclaimed / CHARS_PER_TOKEN)
			// NOT on a forced pass. A forced pass runs because the provider
			// REJECTED the prompt as too long, which is a measurement — and
			// answering it with the same estimate the provider just refuted
			// would declare success after clearing one result and hand back a
			// history that overflows again on the retry.
			const reliefWasEnough =
				!input.force && (estimatedTokens - reclaimedTokens) / budget < config.triggerThreshold
			return {
				kind: 'cleared',
				messages: edit.messages,
				clearedCount: edit.clearedCount,
				charsReclaimed: edit.charsReclaimed,
				reclaimedTokens,
				reliefWasEnough,
			}
		}
	}

	const messages = input.messages
	const systemMessages: Message[] = []
	for (const msg of messages) {
		if (msg.role !== 'system') break
		systemMessages.push(msg)
	}

	// Count and token retention are different boundary policies. In count
	// mode the configured tail plus one older message must fit after the
	// floor. Token mode does not consult keepRecentMessages at all; it only
	// needs one older and one recent message before the token walk and safe
	// boundary search can make the real decision.
	//
	// Preserve the old short-history ordering for a run with no floor: until
	// a host explicitly allows a floorless pass, one notional system message
	// remains part of the admission minimum and `no_system_floor` follows it.
	const floorForAdmission =
		systemMessages.length > 0 ? systemMessages.length : input.allowNoSystemFloor ? 0 : 1
	const minimumMessages =
		config.keepRecentTokens === undefined
			? floorForAdmission + config.keepRecentMessages + 1
			: floorForAdmission + 2
	if (messages.length < minimumMessages) {
		return { kind: 'skip', reason: 'too_few_messages' }
	}

	if (systemMessages.length === 0 && !input.allowNoSystemFloor) {
		return { kind: 'skip', reason: 'no_system_floor' }
	}

	// Tool-pair atomicity. A naive cut at `length - keepRecentMessages` can
	// land BETWEEN an assistant-with-toolCalls (dropped into `older`) and its
	// `tool` results (kept in `recent`), leaving orphaned `tool_result`
	// blocks at the head of the recent window. The provider then emits a
	// `tool_result` with no matching `tool_use` and the API rejects the next
	// turn — so compaction, whose whole job is to keep a long run alive,
	// kills it instead. Snap the boundary backward to a safe point.
	const naiveKeepStart =
		config.keepRecentTokens === undefined
			? messages.length - config.keepRecentMessages
			: naiveKeepStartByTokens(messages, config.keepRecentTokens)
	let keepStart = -1
	for (let candidate = naiveKeepStart; candidate > systemMessages.length; candidate--) {
		if (findSafeTrimIndex(messages as Message[], candidate) === candidate) {
			keepStart = candidate
			break
		}
	}

	// No safe boundary at or below naive. Either every candidate splits a
	// pair-set — one assistant fanning out more calls than the recent window
	// holds — or naive itself sits inside the leading system prefix, which
	// would duplicate those prompts into `recent`. Skipping costs one
	// iteration's headroom; cutting anyway costs the live turn, and the
	// condition is self-clearing.
	if (keepStart < 0) return { kind: 'skip', reason: 'no_safe_cut' }

	const recentMessages = messages.slice(keepStart)
	const olderMessages = messages.slice(systemMessages.length, keepStart)

	// Nothing meaningful to compact — skip rather than thrash the permanent
	// leading floor every iteration, and avoid a model call with no older
	// history to summarise.
	//
	// UNREACHABLE at the current constant, and kept anyway. The loop above
	// requires `candidate > systemMessages.length`, so `keepStart` is at
	// least one past the floor and `olderMessages` is never shorter than
	// one — which is exactly the threshold. Moved here verbatim with the
	// rest of the pass and left in place because it is the guard that stops
	// the pass paying for a summary of nothing, and the two constants it
	// relates are independent: raise this to 2, or relax the loop bound to
	// `>=`, and it starts firing. Said out loud so nobody reads the branch
	// as covered, and so nobody deletes it as dead.
	if (olderMessages.length < MIN_OLDER_MESSAGES_TO_COMPACT) {
		return { kind: 'skip', reason: 'too_few_older' }
	}

	return { kind: 'plan', systemMessages, olderMessages, recentMessages, keepStart }
}

/**
 * Below this, a pass would summarise almost nothing and pay a model call to
 * do it.
 */
export const MIN_OLDER_MESSAGES_TO_COMPACT = 1
