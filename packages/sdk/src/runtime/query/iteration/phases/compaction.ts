import { findSafeTrimIndex } from '../../../../compaction/dangling.js'
import type { WorkingStateManager } from '../../../../compaction/manager.js'
import { serializeState } from '../../../../compaction/serializer.js'
import { buildVerifiedSummary } from '../../../../compaction/verifier.js'
import type { CompactionConfig } from '../../../../config/runtime.js'
import { CHARS_PER_TOKEN } from '../../../../constants/limits.js'
import { type Message, createSystemMessage } from '../../../../types/message/index.js'
import type { IterationContext } from './context.js'

/**
 * Exact prefix of a synthesized compaction summary's content. Exported so the
 * reactive reducer and the proactive check can both strip prior summaries
 * before inserting a fresh one — otherwise repeated compactions stack multiple
 * `[COMPACTED CONTEXT] …` system messages (ses_015 A5, round-2 M9). Residual
 * risk: a genuine user/system message that happens to start with this exact
 * string would also be stripped; treated as acceptable given the sentinel's
 * specificity.
 */
export const COMPACTION_HEADER =
	'[COMPACTED CONTEXT] The following is a structured summary of the conversation so far.'

/** Token estimate for an explicit message array (chars / CHARS_PER_TOKEN). */
export function estimateTokensForMessages(messages: Message[]): number {
	let chars = 0
	for (const msg of messages) {
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

function estimateTokens(ctx: IterationContext): number {
	return estimateTokensForMessages(ctx.runMgr.messages)
}

/** Leading run of system-role messages at the head of the sequence. */
function leadingSystemMessages(messages: Message[]): Message[] {
	const systemMessages: Message[] = []
	for (const msg of messages) {
		if (msg.role !== 'system') break
		systemMessages.push(msg)
	}
	return systemMessages
}

/** Drop any prior compaction summaries from a leading-system run (anti-stacking). */
function stripPriorCompactionSummaries(systemMessages: Message[]): Message[] {
	return systemMessages.filter((m) => !(m.content ?? '').startsWith(COMPACTION_HEADER))
}

export async function runCompactionCheck(ctx: IterationContext): Promise<void> {
	const config = ctx.compactionConfig
	if (!config) return
	if (config.strategy === 'disabled') return

	const manager = ctx.workingStateManager
	if (!manager) return

	const estimatedTokens = estimateTokens(ctx)
	const budget = ctx.runConfig.tokenBudget
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

	const systemMessages = leadingSystemMessages(messages)
	if (systemMessages.length === 0) return

	// Route the proactive cut through findSafeTrimIndex so the split cannot
	// sever a tool call/result pair: a pair straddling the naive boundary is
	// pushed wholly into olderMessages (summarised), never leaving an orphaned
	// result at the head of recentMessages.
	const keepStart = findSafeTrimIndex(messages, messages.length - config.keepRecentMessages)
	const recentMessages = messages.slice(keepStart)
	const olderMessages = messages.slice(systemMessages.length, keepStart)

	let compactedContent: string

	if (config.llmVerification && manager.slotCount() < config.richStateThreshold) {
		compactedContent = await buildVerifiedSummary(manager, olderMessages, ctx.provider, config)
	} else {
		compactedContent = serializeState(manager.getState())
	}

	const compactionMessage = createSystemMessage(`${COMPACTION_HEADER}\n\n${compactedContent}`)

	const newMessages = [
		...stripPriorCompactionSummaries(systemMessages),
		compactionMessage,
		...recentMessages,
	]

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

/**
 * Build a fallback-trim candidate: keep leading system messages, drop the
 * oldest half of the remaining (non-system) messages, adjusting the cut with
 * findSafeTrimIndex so no tool call/result pair is severed. No summary message
 * is produced — this path runs when there is no compaction config / working
 * state to summarise from.
 */
function buildFallbackTrim(messages: Message[]): Message[] {
	const systemMessages = leadingSystemMessages(messages)
	const nonSystemStart = systemMessages.length
	const nonSystemCount = messages.length - nonSystemStart
	if (nonSystemCount <= 1) return messages.slice()

	const dropCount = Math.floor(nonSystemCount / 2)
	const naiveCut = nonSystemStart + dropCount
	const safeCut = findSafeTrimIndex(messages, naiveCut)
	return [...systemMessages, ...messages.slice(safeCut)]
}

/**
 * Build a forced structured-compaction candidate: keep a halved recent window
 * (min 1), summarise everything older into a single serialized-state system
 * message, and strip any prior summaries (anti-stacking). No LLM verifier is
 * used — reactive recovery must not itself issue a model call. Falls back to a
 * plain trim when there is no leading system anchor to attach the summary to.
 */
function buildStructuredReduction(
	messages: Message[],
	config: CompactionConfig,
	manager: WorkingStateManager,
): Message[] {
	const systemMessages = leadingSystemMessages(messages)
	if (systemMessages.length === 0) return buildFallbackTrim(messages)

	const keepRecent = Math.max(1, Math.floor(config.keepRecentMessages / 2))
	const keepStart = findSafeTrimIndex(messages, messages.length - keepRecent)
	const recentMessages = messages.slice(keepStart)

	const compactedContent = serializeState(manager.getState())
	const compactionMessage = createSystemMessage(`${COMPACTION_HEADER}\n\n${compactedContent}`)

	return [...stripPriorCompactionSummaries(systemMessages), compactionMessage, ...recentMessages]
}

/**
 * Reactive context-overflow recovery. Builds a reduction candidate first
 * (pure), estimates it, and commits (in-place splice of the live
 * `runMgr.messages`) ONLY if the estimate strictly shrinks — otherwise leaves
 * the history untouched and returns `false` so the caller stops reissuing
 * (ses_015 A5, round-2 M10, B2). Works without compaction config: absent
 * config / working state / an empty slot set selects the fallback safe-trim
 * path; a configured, non-empty state selects a forced structured pass.
 *
 * @returns `true` if messages were reduced and committed, `false` otherwise.
 */
export function reduceMessagesForOverflow(ctx: IterationContext): boolean {
	const messages = ctx.runMgr.messages
	const config = ctx.compactionConfig
	const manager = ctx.workingStateManager

	const before = estimateTokensForMessages(messages)

	const useStructured =
		!!config && config.strategy !== 'disabled' && !!manager && manager.slotCount() > 0

	const candidate =
		useStructured && config && manager
			? buildStructuredReduction(messages, config, manager)
			: buildFallbackTrim(messages)

	const after = estimateTokensForMessages(candidate)
	if (after >= before) {
		ctx.log.warn('Overflow reduction produced no shrink — leaving history untouched', {
			runId: ctx.runMgr.id,
			beforeTokens: before,
			candidateTokens: after,
			strategy: useStructured ? 'structured' : 'fallback-trim',
		})
		return false
	}

	const oldCount = messages.length
	messages.length = 0
	for (const msg of candidate) {
		messages.push(msg)
	}

	ctx.log.info('Context reduced after overflow', {
		runId: ctx.runMgr.id,
		oldMessageCount: oldCount,
		newMessageCount: messages.length,
		beforeTokens: before,
		afterTokens: after,
		strategy: useStructured ? 'structured' : 'fallback-trim',
	})
	return true
}
