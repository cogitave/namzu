import { resolveContextWindow } from '../../../../compaction/context-window.js'
import { findSafeTrimIndex } from '../../../../compaction/dangling.js'
import { serializeState } from '../../../../compaction/serializer.js'
import { clearStaleToolResults } from '../../../../compaction/tool-result-editing.js'
import { buildVerifiedSummary } from '../../../../compaction/verifier.js'
import { CHARS_PER_TOKEN } from '../../../../constants/limits.js'
import { createSystemMessage } from '../../../../types/message/index.js'
import type { IterationContext } from './context.js'
import { isWorkingMemoryMessage } from './working-memory.js'

const COMPACTION_HEADER =
	'[COMPACTED CONTEXT] The following is a structured summary of the conversation so far.'

/**
 * Identity check for a prior compaction summary in the leading floor. Used to
 * REPLACE one in place on the per-iteration (contextWindowTokens) path so at
 * most one `[COMPACTED CONTEXT]` block ever lives in the never-trimmed floor,
 * and by the checkpoint-restore path to PRESERVE the summary across a resume
 * (it is the only surviving record of the older history the run compacted away).
 */
export function isCompactionMessage(content: string | null | undefined): boolean {
	return typeof content === 'string' && content.startsWith(COMPACTION_HEADER)
}

/**
 * Minimum number of compactable (older) messages required before a compaction
 * pass is worth running. When there is NOTHING between the never-trimmed
 * leading floor and the recent window, a pass would only replace nothing with a
 * `[COMPACTED CONTEXT]` summary that joins the floor — pure overhead that fires
 * again next iteration (the permanent-floor thrash, ses_055 D7). Set to the
 * literal EMPTY guard so any existing compaction consumer with ≥1 older message
 * stays byte-identical; the per-iteration Vandal path additionally defangs the
 * cost with `llmVerification:false`.
 */
const MIN_OLDER_MESSAGES_TO_COMPACT = 1

/**
 * Model-visible size of a message body, in characters.
 *
 * An image block is measured by its base64 payload because that is what
 * actually occupies the request. It is NOT what the model is billed for —
 * an image costs far fewer tokens than its base64 length divided by four —
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

function estimateTokens(ctx: IterationContext): number {
	let chars = 0
	for (const msg of ctx.runMgr.messages) {
		// `content` is `string | ToolResultBlock[]`. On an array, `.length` is
		// the BLOCK COUNT, so a tool result carrying a 400 KB screenshot
		// contributed 1 — and the estimate that decides when to compact read
		// near zero for exactly the runs that need compacting most.
		chars += measureContentChars(msg.content)
		if (msg.role === 'assistant' && msg.toolCalls) {
			for (const tc of msg.toolCalls) {
				chars += tc.function.name.length + tc.function.arguments.length
			}
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN)
}

/**
 * How full the context is, in tokens.
 *
 * Prefer the provider's own count of the last prompt — it is a measurement,
 * not a guess, and it includes everything the heuristic cannot see (tool
 * schemas, system blocks, image tokens, per-message framing). The chars/4
 * estimate remains the fallback for iteration 1, before any turn has
 * reported, and for providers that do not return usage.
 */
function measureContext(ctx: IterationContext): {
	tokens: number
	source: 'provider' | 'estimate'
} {
	const reported = ctx.runMgr.lastPromptTokens
	if (reported !== undefined && reported > 0) {
		return { tokens: reported, source: 'provider' }
	}
	return { tokens: estimateTokens(ctx), source: 'estimate' }
}

/**
 * Shed history because the PROVIDER said the prompt is too long.
 *
 * The threshold path guesses when to compact and can guess low — the
 * estimate is a heuristic, and a run carrying images or a language the
 * chars-per-token ratio does not fit will hit the real window while still
 * reading as comfortable. When that happens the provider tells us exactly
 * what is wrong, and the kernel already classifies it precisely and then
 * did nothing with it: the call was correctly marked non-retryable
 * (resending the identical prompt cannot help) and the run died holding a
 * compaction subsystem that could have made room.
 *
 * Forced rather than threshold-gated, because the threshold is the thing
 * that was just proven wrong.
 *
 * @returns whether anything was actually shed. `false` means retrying would
 *   send the same prompt again, so the caller must not.
 */
export async function relieveOverflow(ctx: IterationContext): Promise<boolean> {
	const before = ctx.runMgr.messages.length
	const beforeChars = totalChars(ctx.runMgr.messages)

	await runCompactionCheck(ctx, { force: true })

	const shed = beforeChars - totalChars(ctx.runMgr.messages)
	if (shed <= 0) {
		ctx.log.warn('Context overflow with nothing left to shed — the prompt is irreducible', {
			runId: ctx.runMgr.id,
			messages: before,
		})
		return false
	}

	ctx.log.info('Relieved a context overflow by compacting', {
		runId: ctx.runMgr.id,
		messagesBefore: before,
		messagesAfter: ctx.runMgr.messages.length,
		charsShed: shed,
	})
	return true
}

function totalChars(messages: readonly { content: unknown }[]): number {
	let total = 0
	for (const msg of messages) total += measureContentChars(msg.content)
	return total
}

export async function runCompactionCheck(
	ctx: IterationContext,
	options?: { force?: boolean },
): Promise<void> {
	const config = ctx.compactionConfig
	if (!config) return
	if (config.strategy === 'disabled') return

	const manager = ctx.workingStateManager
	if (!manager) return

	const measured = measureContext(ctx)
	const estimatedTokens = measured.tokens

	// The divisor is a WINDOW, never `runConfig.tokenBudget`. The old
	// fallback compared a live context size against a cumulative spend cap
	// — dimensionally the wrong quantity, and self-defeating: the guard
	// force-finalizes at 0.9 x tokenBudget while this needs 0.7 x the same
	// number. Nothing in the estate ever set `contextWindowTokens`, so the
	// fallback WAS the behavior, and the shipped CLI's 1M budget put the
	// trigger at ~700k. See `compaction/context-window.ts`.
	const window = resolveContextWindow(config.contextWindowTokens, ctx.runConfig.model)
	const budget = window.tokens

	const usage = estimatedTokens / budget

	// A forced pass skips the threshold: it runs because the provider
	// rejected the prompt, which is stronger evidence than any estimate.
	if (!options?.force && usage < config.triggerThreshold) return

	ctx.log.info('Compaction threshold reached — compacting context', {
		runId: ctx.runMgr.id,
		contextTokens: estimatedTokens,
		measuredBy: measured.source,
		window: budget,
		windowSource: window.source,
		usage: Math.round(usage * 100),
		triggerThreshold: config.triggerThreshold,
		slotCount: manager.slotCount(),
	})

	// Try the cheap, NON-destructive reclaim first: clear the output of old,
	// large tool results in place. Compaction paraphrases the agent's own
	// reasoning away, which is a heavy price for a context problem usually
	// caused by something dumber — a few enormous tool outputs the agent
	// already read and moved past. Clearing those keeps every message
	// verbatim, and keeps `tool_use` ↔ `tool_result` pairing intact by
	// construction, because nothing moves.
	if (config.clearToolResults !== false) {
		const edit = clearStaleToolResults(ctx.runMgr.messages, {
			...(config.keepRecentToolResults !== undefined
				? { keepRecentToolResults: config.keepRecentToolResults }
				: {}),
			...(config.minToolResultCharsToClear !== undefined
				? { minCharsToClear: config.minToolResultCharsToClear }
				: {}),
			...(config.preserveToolResultsFrom ? { preserveTools: config.preserveToolResultsFrom } : {}),
		})

		if (edit.clearedCount > 0) {
			// Element-wise, not a rebuild: the edit is length-preserving by
			// construction (only `content` changes), so writing entries back
			// keeps the live array identity the rest of the run holds.
			const live = ctx.runMgr.messages
			edit.messages.forEach((msg, i) => {
				live[i] = msg
			})

			const reclaimedTokens = Math.ceil(edit.charsReclaimed / CHARS_PER_TOKEN)
			ctx.log.info('Cleared stale tool results instead of compacting', {
				runId: ctx.runMgr.id,
				cleared: edit.clearedCount,
				charsReclaimed: edit.charsReclaimed,
				reclaimedTokens,
			})

			// If that was enough, stop here and keep the history verbatim.
			// The measurement is an estimate either way; the provider's own
			// count for the NEXT turn will correct it, and an over-eager
			// summarization is far more costly than one late pass.
			if ((estimatedTokens - reclaimedTokens) / budget < config.triggerThreshold) {
				return
			}
		}
	}

	const messages = ctx.runMgr.messages
	if (messages.length < config.keepRecentMessages + 2) {
		ctx.log.debug('Not enough messages to compact', {
			messageCount: messages.length,
			keepRecentMessages: config.keepRecentMessages,
		})
		return
	}

	const systemMessages: typeof messages = []
	for (const msg of messages) {
		if (msg.role !== 'system') break
		systemMessages.push(msg)
	}
	if (systemMessages.length === 0) return

	// Tool-pair atomicity guard. A naive cut at `length - keepRecentMessages`
	// can land BETWEEN an assistant-with-toolCalls (which would be dropped into
	// `olderMessages`) and its `tool` results (kept in `recentMessages`),
	// leaving orphaned `tool_result` blocks at the head of the recent window.
	// The Anthropic provider then emits a `tool_result` with no matching
	// `tool_use` and the API rejects the next turn with a 400 — so compaction,
	// whose whole job is to keep a long run alive, instead kills it. Snap the
	// boundary FORWARD to a safe point (existing `findSafeTrimIndex`, previously
	// only wired to the unused ConversationManager strategy classes) so no pair
	// is split. Any message this moves out of the recent window is already
	// represented in the extracted WorkingState the summary is built from.
	const keepStart = findSafeTrimIndex(messages, messages.length - config.keepRecentMessages)
	const recentMessages = messages.slice(keepStart)
	const olderMessages = messages.slice(systemMessages.length, keepStart)

	// D7: nothing meaningful to compact — skip instead of thrashing the
	// permanent leading floor every iteration (and avoid an LLM verification
	// call when there is no older history to summarize).
	//
	// This guard used to be gated on `contextWindowTokens != null` to keep
	// the tokenBudget path byte-identical. That path's actual behavior was
	// "never fires", so there is nothing left to preserve — and now that the
	// trigger works, an ungated consumer would thrash. Same for the prior-
	// summary replacement below.
	if (olderMessages.length < MIN_OLDER_MESSAGES_TO_COMPACT) {
		ctx.log.debug('Skipping compaction — too few older messages', {
			runId: ctx.runMgr.id,
			olderMessages: olderMessages.length,
		})
		return
	}

	let compactedContent: string

	if (config.llmVerification && manager.slotCount() < config.richStateThreshold) {
		compactedContent = await buildVerifiedSummary(
			manager,
			olderMessages,
			ctx.provider,
			config,
			(usage) => ctx.runMgr.accumulateUsage(usage),
			ctx.runConfig.model,
		)
	} else {
		compactedContent = serializeState(manager.getState())
	}

	const compactionMessage = createSystemMessage(`${COMPACTION_HEADER}\n\n${compactedContent}`)

	// Drop any PRIOR `[COMPACTED CONTEXT]` summary from the leading floor —
	// `serializeState` is cumulative, so the new summary supersedes it.
	// Without this the never-trimmed floor accumulates one redundant summary
	// per pass, unbounded. Unconditional now, for the reason given at the
	// thrash guard above.
	const preservedSystem = systemMessages.filter(
		(m) => !isCompactionMessage(typeof m.content === 'string' ? m.content : null),
	)
	const newMessages = [...preservedSystem, compactionMessage, ...recentMessages]

	// OPAQUE survival guard (ses_055 D1): the pinned working-memory slot is a
	// leading system message, so it is kept in `preservedSystem` (the compaction
	// filter only drops prior `[COMPACTED CONTEXT]` summaries, never the WM slot)
	// and survives for free — this branch is DEFENSIVE-ONLY, exercised only if a
	// future change drops the slot from the rebuilt set. It re-pins the block
	// already present in `messages` (the one `refreshWorkingMemory` placed).
	// Identity is the sentinel HEADER only — no path parsing, no second provider
	// call, no host format knowledge in the SDK.
	const survives = newMessages.some((m) => m.role === 'system' && isWorkingMemoryMessage(m.content))
	if (!survives) {
		const priorSlot = messages.find((m) => m.role === 'system' && isWorkingMemoryMessage(m.content))
		if (priorSlot) {
			// Re-pin as the last leading system message, before the summary.
			newMessages.splice(preservedSystem.length, 0, priorSlot)
			ctx.log.warn('Re-pinned working-memory slot dropped by compaction', {
				runId: ctx.runMgr.id,
			})
		}
	}

	const oldCount = messages.length
	messages.length = 0
	for (const msg of newMessages) {
		messages.push(msg)
	}

	const newEstimate = estimateTokens(ctx)

	// The provider's count described the PRE-compaction prompt; the window
	// it just shrank to has not been sent yet, so the post number is
	// necessarily an estimate. Invalidate the stale reading so the next
	// trigger check does not compare the old prompt size against the new
	// context and compact again immediately.
	ctx.runMgr.clearLastPromptTokens()

	// Hysteresis. A pass that only gets the context from 0.72 to 0.71 of the
	// window leaves the trigger armed, so the next iteration compacts again
	// — paying a summarization call and busting the prompt-cache prefix each
	// time, for nothing. Report the shortfall rather than repeating a move
	// that demonstrably does not work; `resetThreshold` was declared and
	// CLI-set but read by nothing until now.
	const reachedReset = newEstimate / budget <= config.resetThreshold
	if (!reachedReset) {
		ctx.log.warn('Compaction did not reach its reset threshold — context may still be tight', {
			runId: ctx.runMgr.id,
			afterUsage: Math.round((newEstimate / budget) * 100),
			resetThreshold: Math.round(config.resetThreshold * 100),
			hint: 'lower keepRecentMessages, or raise the context window if the model supports one',
		})
	}

	ctx.log.info('Context compacted', {
		runId: ctx.runMgr.id,
		oldMessageCount: oldCount,
		newMessageCount: messages.length,
		removedMessages: oldCount - messages.length,
		oldTokenEstimate: estimatedTokens,
		newTokenEstimate: newEstimate,
		reductionPercent: Math.round((1 - newEstimate / estimatedTokens) * 100),
		reachedReset,
		slotCount: manager.slotCount(),
	})

	// Compaction is destructive and was, until now, completely silent: no
	// event, no transcript record, nothing a host could surface. Emit the
	// loss so it is observable.
	await ctx.emitEvent({
		type: 'compaction_completed',
		runId: ctx.runMgr.id,
		iteration: ctx.runMgr.currentIteration,
		messagesBefore: oldCount,
		messagesAfter: messages.length,
		tokensBefore: estimatedTokens,
		tokensAfter: newEstimate,
		measuredBy: measured.source,
		contextWindowTokens: budget,
		windowSource: window.source,
		reachedResetThreshold: reachedReset,
	})
}
