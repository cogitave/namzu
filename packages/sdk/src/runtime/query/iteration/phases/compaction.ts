import { findSafeTrimIndex } from '../../../../compaction/dangling.js'
import type { WorkingStateManager } from '../../../../compaction/manager.js'
import { serializeState } from '../../../../compaction/serializer.js'
import { buildVerifiedSummaryParts } from '../../../../compaction/verifier.js'
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
 * Header of the working-state region of a summary body.
 *
 * Everything under it is re-serialized from the {@link WorkingStateManager} on
 * every pass, which is exactly why a later pass DISCARDS it instead of carrying it:
 * the marker is what lets the parser tell "state this writer will regenerate
 * anyway" apart from "text that exists nowhere else". Without that distinction each
 * pass appended the whole previous body to a freshly serialized state, so the state
 * was duplicated every pass and the carry markers nested (ses_015 pre-freeze R4 B2).
 */
export const STATE_HEADER = '[Working state]'

/**
 * Header of the carry region: what the older conversation contained that the
 * working state does NOT hold — this pass's verifier findings, and the same from
 * every earlier pass — newest first.
 */
export const CARRY_HEADER = '[Additional context not captured in the working state]'

/** Boundary between two carry entries. One entry is one pass's own contribution. */
const CARRY_ENTRY_DELIMITER = '\n\n[--- from an earlier compaction ---]\n\n'

/** Marks where a single over-budget entry was cut. */
export const CARRY_ELISION_MARKER = '\n[... elided to fit the carry budget]'

/**
 * The carry entries held by one prior summary, newest first.
 *
 * The head region is dropped when it carries {@link STATE_HEADER} — that is this
 * writer's own working state, and this pass re-serializes it from the manager. A
 * head WITHOUT the marker came from somewhere else (a summary written before this
 * format, or by another tool) and is kept as an entry: dropping it would take the
 * only copy of its facts with it.
 */
function carryEntriesOf(summary: Message): string[] {
	const body = (summary.content ?? '').slice(COMPACTION_HEADER.length).trim()
	const carryAt = body.indexOf(CARRY_HEADER)
	const head = (carryAt === -1 ? body : body.slice(0, carryAt)).trim()
	const carried = carryAt === -1 ? '' : body.slice(carryAt + CARRY_HEADER.length)

	const entries = carried
		.split(CARRY_ENTRY_DELIMITER)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)

	if (head.length > 0 && !head.startsWith(STATE_HEADER)) entries.unshift(head)
	return entries
}

/**
 * Every carry entry in the history, newest first, deduplicated by exact text.
 *
 * Newest first is the whole point: the cap drops from the END of this list, so the
 * material most likely to still matter is the material that survives. Duplicates
 * are real — a forced reduction can leave a summary interleaved in the recent
 * window while the summary that already carried its text sits at the head — and
 * without the dedupe that text would be counted twice against the budget and
 * evict something older that is not held anywhere else.
 */
function priorCarryEntries(messages: Message[]): string[] {
	const summaries = messages.filter(isCompactionSummary)
	const entries: string[] = []
	for (let i = summaries.length - 1; i >= 0; i--) {
		const summary = summaries[i]
		if (summary) entries.push(...carryEntriesOf(summary))
	}
	return dedupeEntries(entries)
}

function dedupeEntries(entries: string[]): string[] {
	const seen = new Set<string>()
	const unique: string[] = []
	for (const entry of entries) {
		if (seen.has(entry)) continue
		seen.add(entry)
		unique.push(entry)
	}
	return unique
}

/**
 * Cap the carry list at `budget` characters by dropping WHOLE entries from the end
 * of the list — the oldest.
 *
 * The cap this replaces sliced the last `budget` characters off a single
 * concatenated blob. The blob ran oldest-last, so the surviving tail was the
 * OLDEST material and the newest findings — sitting near the front — were the ones
 * cut: the exact inverse of the policy this function is named for. A third pass
 * could drop precisely what the second pass had just discovered (ses_015 pre-freeze
 * R4 B2).
 *
 * The newest entry is the one entry that must not be dropped, so when it alone
 * exceeds the budget it is truncated instead — head kept, tail elided behind
 * {@link CARRY_ELISION_MARKER} — rather than silently vanishing and leaving room
 * for older entries in its place.
 */
function capCarryEntries(entries: string[], budget: number): string[] {
	const kept: string[] = []
	let used = 0

	for (const entry of entries) {
		const cost = entry.length + (kept.length > 0 ? CARRY_ENTRY_DELIMITER.length : 0)
		if (used + cost <= budget) {
			kept.push(entry)
			used += cost
			continue
		}
		if (kept.length === 0) {
			const room = budget - CARRY_ELISION_MARKER.length
			if (room > 0) kept.push(entry.slice(0, room) + CARRY_ELISION_MARKER)
		}
		// Everything past this entry is older than it. Newest-first means the drop
		// happens here and takes the whole remainder of the list.
		break
	}

	return kept
}

/**
 * Assemble a summary body: the working state as re-serialized on THIS pass, then
 * the bounded newest-first carry list.
 *
 * Both compaction paths build their body here — the LLM-verified one and the
 * serialize-only one — so the carry policy cannot drift between them. It already
 * had: the carry landed on the serialize-only branch first and the default,
 * verified branch went on losing summaries for a round.
 */
function buildSummaryBody(serialized: string, carryEntries: string[], budget: number): string {
	const state = `${STATE_HEADER}\n${serialized}`
	const capped = capCarryEntries(carryEntries, budget)
	if (capped.length === 0) return state
	return `${state}\n\n${CARRY_HEADER}\n${capped.join(CARRY_ENTRY_DELIMITER)}`
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

	// Carry forward what the prior summaries hold and the working state does not, so
	// a fact captured only in an earlier [COMPACTED CONTEXT] block (and never
	// promoted to a working-state slot) survives this pass (ses_015 fix-batch).
	// Scanned over the WHOLE history, not just the leading system run, so an
	// interleaved summary is carried and then dropped rather than left behind to
	// stack (pre-freeze M2).
	const prior = priorCarryEntries(messages)

	let serialized: string
	let additions = ''

	if (config.llmVerification && manager.slotCount() < config.richStateThreshold) {
		// Feed the carried entries into the verifier input (as the leading context so
		// budget-truncation can't drop them) alongside the raw older messages. Those
		// are stripped of summary blocks first — carried separately, they would
		// otherwise reach the verifier twice.
		const olderWithoutSummaries = stripPriorCompactionSummaries(olderMessages)
		const verifierInput =
			prior.length > 0
				? [
						createSystemMessage(`${CARRY_HEADER}\n${prior.join(CARRY_ENTRY_DELIMITER)}`),
						...olderWithoutSummaries,
					]
				: olderWithoutSummaries

		// The verifier's findings are taken SEPARATELY from the state it was given, and
		// become this pass's own carry entry. Its happy path — it answers COMPLETE —
		// returns the serialized state alone, so anything that reached it only as input
		// is nowhere in its output, while the strip below removes the original block
		// from the history: the fact would be gone. That is the loss this carry exists
		// to prevent, and it was live on the branch most runs take (pre-freeze R1).
		const parts = await buildVerifiedSummaryParts(manager, verifierInput, ctx.provider, config)
		serialized = parts.serialized
		additions = parts.additions
	} else {
		serialized = serializeState(manager.getState())
	}

	const own = additions.trim()
	const compactedContent = buildSummaryBody(
		serialized,
		own ? dedupeEntries([own, ...prior]) : prior,
		config.convoTextBudget,
	)

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
	// must not issue a model call, so this pass contributes no verifier findings of
	// its own — it carries what is already there, under the same policy as the
	// proactive path. Scanned over the whole history and stripped on both sides of
	// the insert (pre-freeze M2).
	const compactedContent = buildSummaryBody(
		serializeState(manager.getState()),
		priorCarryEntries(messages),
		config.convoTextBudget,
	)
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
