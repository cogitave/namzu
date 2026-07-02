import { serializeState } from '../../../../compaction/serializer.js'
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
 * most one `[COMPACTED CONTEXT]` block ever lives in the never-trimmed floor.
 */
function isCompactionMessage(content: string | null | undefined): boolean {
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

function estimateTokens(ctx: IterationContext): number {
	let chars = 0
	for (const msg of ctx.runMgr.messages) {
		if (msg.content) {
			chars += msg.content.length
		}
		if (msg.role === 'assistant' && msg.toolCalls) {
			for (const tc of msg.toolCalls) {
				chars += tc.function.name.length + tc.function.arguments.length
			}
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN)
}

export async function runCompactionCheck(ctx: IterationContext): Promise<void> {
	const config = ctx.compactionConfig
	if (!config) return
	if (config.strategy === 'disabled') return

	const manager = ctx.workingStateManager
	if (!manager) return

	const estimatedTokens = estimateTokens(ctx)
	// F1: measure the CURRENT window against the model context window when the
	// host supplies one, falling back to the run-level cumulative `tokenBudget`
	// otherwise. Repointing the SINGLE `budget` assignment moves BOTH the
	// `<= 0` guard AND the divisor at once — so "compaction on + tokenBudget=0"
	// is no longer a silent no-op. Existing consumers (no contextWindowTokens)
	// stay byte-identical.
	const budget = config.contextWindowTokens ?? ctx.runConfig.tokenBudget
	if (budget <= 0) return

	const usage = estimatedTokens / budget

	if (usage < config.triggerThreshold) return

	ctx.log.info('Compaction threshold reached — compacting context', {
		runId: ctx.runMgr.id,
		estimatedTokens,
		budget,
		usage: Math.round(usage * 100),
		triggerThreshold: config.triggerThreshold,
		slotCount: manager.slotCount(),
	})

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

	const keepStart = messages.length - config.keepRecentMessages
	const recentMessages = messages.slice(keepStart)
	const olderMessages = messages.slice(systemMessages.length, keepStart)

	// D7: nothing meaningful to compact — skip instead of thrashing the
	// permanent leading floor every iteration (and avoid an LLM verification
	// call when there is no older history to summarize). Scoped to the new
	// contextWindowTokens path so any existing consumer (tokenBudget-only) keeps
	// its exact prior behavior — byte-identical (ses_055 verify).
	if (config.contextWindowTokens != null && olderMessages.length < MIN_OLDER_MESSAGES_TO_COMPACT) {
		ctx.log.debug('Skipping compaction — too few older messages', {
			runId: ctx.runMgr.id,
			olderMessages: olderMessages.length,
		})
		return
	}

	let compactedContent: string

	if (config.llmVerification && manager.slotCount() < config.richStateThreshold) {
		compactedContent = await buildVerifiedSummary(manager, olderMessages, ctx.provider, config)
	} else {
		compactedContent = serializeState(manager.getState())
	}

	const compactionMessage = createSystemMessage(`${COMPACTION_HEADER}\n\n${compactedContent}`)

	// On the new per-iteration (contextWindowTokens) path, drop any PRIOR
	// `[COMPACTED CONTEXT]` summary from the leading floor — `serializeState` is
	// cumulative, so the new summary supersedes it. Without this the never-trimmed
	// floor accumulates one redundant summary per pass and the frequent
	// per-iteration trigger makes that bloat unbounded (ses_055 verify, MEDIUM).
	// Legacy consumers (no contextWindowTokens) keep their exact prior
	// accumulation behavior — byte-identical.
	const preservedSystem =
		config.contextWindowTokens != null
			? systemMessages.filter((m) => !isCompactionMessage(m.content))
			: systemMessages
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

	ctx.log.info('Context compacted', {
		runId: ctx.runMgr.id,
		oldMessageCount: oldCount,
		newMessageCount: messages.length,
		removedMessages: oldCount - messages.length,
		oldTokenEstimate: estimatedTokens,
		newTokenEstimate: newEstimate,
		reductionPercent: Math.round((1 - newEstimate / estimatedTokens) * 100),
		slotCount: manager.slotCount(),
	})
}
