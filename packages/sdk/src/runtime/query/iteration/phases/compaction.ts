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

/**
 * A system message carrying a prior compaction summary. Recognised ANYWHERE in
 * the sequence, not just in the leading system run: a forced reduction keeps a
 * halved recent window, and a summary inserted by an earlier pass can end up
 * inside it — leaving it interleaved rather than leading. Scanning only the head
 * let those survive and stack (ses_015 pre-freeze M2).
 */
function isCompactionSummary(message: Message): boolean {
	return message.role === 'system' && (message.content ?? '').startsWith(COMPACTION_HEADER)
}

/** Drop every prior compaction summary from a message run (anti-stacking). */
function stripPriorCompactionSummaries(messages: Message[]): Message[] {
	return messages.filter((m) => !isCompactionSummary(m))
}

/**
 * Extract the body text (everything after {@link COMPACTION_HEADER}) of every
 * prior compaction summary in the sequence, oldest first. Anti-stacking replaces
 * these summaries with a fresh one, so their content must be carried forward or
 * any fact captured only inside an earlier summary is lost (ses_015 fix-batch).
 */
function extractPriorSummaryBodies(messages: Message[]): string[] {
	const bodies: string[] = []
	for (const m of messages) {
		if (!isCompactionSummary(m)) continue
		const content = m.content ?? ''
		bodies.push(content.slice(COMPACTION_HEADER.length).replace(/^\s+/, ''))
	}
	return bodies
}

/**
 * Build the `[Carried from prior summary]` continuity section appended to a
 * serialize-only summary. Prior bodies are joined oldest-first and capped to
 * `budget` chars by dropping the oldest text first (keeping the newest tail), so
 * repeated compactions stay bounded while never silently forgetting the most
 * recent summary. Returns '' when there is nothing to carry.
 */
function buildCarriedSummarySection(priorBodies: string[], budget: number): string {
	if (priorBodies.length === 0) return ''
	let combined = priorBodies.join('\n\n')
	if (combined.length > budget) {
		combined = combined.slice(combined.length - budget)
	}
	return `\n\n[Carried from prior summary]\n${combined}`
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

	// Bounded, downward cut search (ses_015 fix-batch). The naive cut keeps the
	// last keepRecentMessages messages raw. A forward-only findSafeTrimIndex can
	// advance PAST the recent window (summarising away the latest user turn) or
	// land inside the leading system run (duplicating system prompts, removing
	// nothing). Instead we take the LARGEST safe cut <= naive: the recent window
	// then never shrinks below the config intent, keepStart stays strictly above
	// the system run, and a tool pair straddling the naive point is kept wholly in
	// the recent window rather than split.
	const naive = messages.length - config.keepRecentMessages
	if (naive <= systemMessages.length) {
		ctx.log.debug('Nothing older than the recent window to compact', {
			messageCount: messages.length,
			keepRecentMessages: config.keepRecentMessages,
			systemCount: systemMessages.length,
		})
		return
	}

	let keepStart = -1
	for (let candidate = naive; candidate > systemMessages.length; candidate--) {
		if (candidate === findSafeTrimIndex(messages, candidate)) {
			keepStart = candidate
			break
		}
	}

	if (keepStart === -1) {
		// No safe cut at or below naive (a long unbroken tool chain). Advance
		// forward once, but only commit if it still leaves at least one non-system
		// message raw; otherwise skip this pass rather than summarise the whole
		// tail including the live user prompt.
		const forward = findSafeTrimIndex(messages, naive)
		if (forward > messages.length - 1) {
			ctx.log.debug('No safe compaction cut leaves a recent window — skipping pass', {
				messageCount: messages.length,
				keepRecentMessages: config.keepRecentMessages,
			})
			return
		}
		keepStart = forward
	}

	const recentMessages = messages.slice(keepStart)
	const olderMessages = messages.slice(systemMessages.length, keepStart)

	// A cut that folds in nothing older would only add a summary and re-trigger
	// next iteration (no-shrink loop). keepStart > systemMessages.length keeps
	// this defensive, but guard anyway.
	if (olderMessages.length === 0) {
		ctx.log.debug('Compaction cut removes nothing — skipping pass', {
			messageCount: messages.length,
		})
		return
	}

	// Carry prior summary text into the new summary so a fact captured only in an
	// earlier [COMPACTED CONTEXT] block (and never promoted to a working-state
	// slot) survives this pass (ses_015 fix-batch). Scanned over the WHOLE history,
	// not just the leading system run, so an interleaved summary is carried and
	// then dropped rather than left behind to stack (pre-freeze M2).
	const priorSummaryBodies = extractPriorSummaryBodies(messages)

	let compactedContent: string

	if (config.llmVerification && manager.slotCount() < config.richStateThreshold) {
		// Feed the prior summaries into the verifier input (as the leading context
		// so budget-truncation can't drop them) alongside the raw older messages.
		// Those are stripped of summary blocks first — carried separately, they
		// would otherwise reach the verifier twice.
		const olderWithoutSummaries = stripPriorCompactionSummaries(olderMessages)
		const verifierInput =
			priorSummaryBodies.length > 0
				? [
						createSystemMessage(`[Carried from prior summary]\n${priorSummaryBodies.join('\n\n')}`),
						...olderWithoutSummaries,
					]
				: olderWithoutSummaries
		const verified = await buildVerifiedSummary(manager, verifierInput, ctx.provider, config)

		// The carry is appended to the verifier's OUTPUT, not merely handed to it as
		// input. On the verifier's happy path — it answers COMPLETE — buildVerifiedSummary
		// returns the serialized state alone, so a prior summary that reached it only as
		// input is nowhere in the result, while the strip below removes the original
		// block from the history: the fact is gone. That is the loss this carry exists
		// to prevent, and it was live on the branch most runs take (ses_015 pre-freeze R1).
		compactedContent =
			verified + buildCarriedSummarySection(priorSummaryBodies, config.convoTextBudget)
	} else {
		compactedContent =
			serializeState(manager.getState()) +
			buildCarriedSummarySection(priorSummaryBodies, config.convoTextBudget)
	}

	const compactionMessage = createSystemMessage(`${COMPACTION_HEADER}\n\n${compactedContent}`)

	// Strip on BOTH sides of the insert: a summary can sit in the leading system
	// run or, after a forced reduction, inside the recent window. Dropping a
	// system message can never sever a tool call/result pair.
	const newMessages = [
		...stripPriorCompactionSummaries(systemMessages),
		compactionMessage,
		...stripPriorCompactionSummaries(recentMessages),
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
 * oldest half of the remaining **non-system** messages, adjusting the cut with
 * findSafeTrimIndex so no tool call/result pair is severed. No summary message
 * is produced — this path runs when there is no compaction config / working
 * state to summarise from.
 *
 * "Half" is counted over actual non-system messages, and the cut lands on the
 * first non-system message that survives. Counting raw positions instead let
 * interleaved system messages (a prior compaction summary, say) inflate the
 * count and push the cut arbitrarily deep — far enough, in a summary-heavy
 * history, to walk off the end of the conversation (ses_015 pre-freeze M3).
 */
function buildFallbackTrim(messages: Message[]): Message[] {
	const systemMessages = leadingSystemMessages(messages)
	const nonSystemStart = systemMessages.length

	const nonSystemIndices: number[] = []
	for (let i = nonSystemStart; i < messages.length; i++) {
		const msg = messages[i]
		if (msg && msg.role !== 'system') nonSystemIndices.push(i)
	}
	if (nonSystemIndices.length <= 1) return messages.slice()

	const dropCount = Math.floor(nonSystemIndices.length / 2)
	const naiveCut = nonSystemIndices[dropCount] ?? messages.length
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

	// Carry prior summary text forward so anti-stacking does not drop a fact that
	// lived only inside an earlier summary (ses_015 fix-batch). Reactive recovery
	// must not issue a model call, so this is a serialize-only append. Scanned over
	// the whole history and stripped on both sides of the insert (pre-freeze M2).
	const priorSummaryBodies = extractPriorSummaryBodies(messages)
	const compactedContent =
		serializeState(manager.getState()) +
		buildCarriedSummarySection(priorSummaryBodies, config.convoTextBudget)
	const compactionMessage = createSystemMessage(`${COMPACTION_HEADER}\n\n${compactedContent}`)

	return [
		...stripPriorCompactionSummaries(systemMessages),
		compactionMessage,
		...stripPriorCompactionSummaries(recentMessages),
	]
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

	let candidate =
		useStructured && config && manager
			? buildStructuredReduction(messages, config, manager)
			: buildFallbackTrim(messages)
	let strategy = useStructured ? 'structured' : 'fallback-trim'
	let after = estimateTokensForMessages(candidate)

	// Cascade (ses_015 fix-batch): a structured candidate that cannot shrink
	// (e.g. keepRecent >= history, so it re-includes everything plus a summary)
	// must not strand the run. Fall back to the plain safe-trim, which can drop
	// the oldest oversized tool pair even when structured cannot. Only give up if
	// neither candidate shrinks.
	if (after >= before && useStructured) {
		const trimCandidate = buildFallbackTrim(messages)
		const trimAfter = estimateTokensForMessages(trimCandidate)
		if (trimAfter < before) {
			candidate = trimCandidate
			after = trimAfter
			strategy = 'fallback-trim'
		}
	}

	if (after >= before) {
		ctx.log.warn('Overflow reduction produced no shrink — leaving history untouched', {
			runId: ctx.runMgr.id,
			beforeTokens: before,
			candidateTokens: after,
			strategy,
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
		strategy,
	})
	return true
}
