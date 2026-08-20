import type { CompactionConfig } from '../config/runtime.js'
import { resolveStreamIdleTimeoutMs } from '../provider/idle-timeout.js'
import { NamzuError } from '../types/errors/index.js'
import { toolResultToText } from '../types/message/content.js'
import type { Message } from '../types/message/index.js'
import type { LLMProvider } from '../types/provider/index.js'
import { resolveContextWindow } from './context-window.js'
import { findDanglingMessages, findSafeTrimIndex } from './dangling.js'
import {
	extractFromAssistantMessage,
	extractFromToolCall,
	extractFromToolResult,
	extractFromUserMessage,
} from './extractor.js'
import { WorkingStateManager } from './manager.js'
import { planCompaction } from './plan.js'
import { findRetainedIndices } from './retention.js'
import { buildCompactionMessage, isCompactionMessage } from './summary.js'
import { type CompactionVerificationOptions, buildVerifiedSummary } from './verifier.js'

/**
 * Compaction a host can ask for, rather than one that only happens to it.
 *
 * `runCompactionCheck` was the only entry point in the kernel and it was
 * exported from nowhere. So a host could not offer "compact this
 * conversation", could not shrink an idle session sitting between turns,
 * and could not collapse a span it had chosen — every compaction had to
 * wait for the in-loop threshold or a provider overflow retry.
 *
 * These are that entry point, built on the planner rather than on a second
 * copy of the boundary arithmetic. Nothing here touches an
 * `IterationContext`: there is no run, which is the whole point.
 */

export interface CompactionResult {
	/** The new history. A fresh array — the input is never edited. */
	readonly messages: readonly Message[]
	/** How many messages the pass removed. Always at least one. */
	readonly shed: number
	/** The summary that replaced them, as it appears in `messages`. */
	readonly summary: Message
}

export interface CompactNowInput extends CompactionVerificationOptions {
	readonly messages: readonly Message[]
	readonly config: CompactionConfig
	readonly provider: LLMProvider
	readonly model?: string
	readonly contextWindowTokens?: number
}

function admitManualCompaction(input: CompactionVerificationOptions): void {
	input.signal?.throwIfAborted()
	// Validate at the public boundary even when the history is too short to
	// call the verifier. A malformed liveness policy is not a successful no-op.
	resolveStreamIdleTimeoutMs(input.streamIdleTimeoutMs)
}

/** Assembles the new history from a plan's partition plus its summary. */
function preservedSystemFloor(systemMessages: readonly Message[]): Message[] {
	// A replaceable in-run summary may be superseded. A pinned summary may not:
	// `retain` is the public promise that compaction leaves the message alone,
	// and a prior manual summary is opaque state rather than redundant prose.
	return systemMessages.filter(
		(m) =>
			!isCompactionMessage(typeof m.content === 'string' ? m.content : null) || m.retain === true,
	)
}

function splice(
	preservedSystem: readonly Message[],
	summaryBody: string,
	retainedOlder: readonly Message[],
	recentMessages: readonly Message[],
): { messages: Message[]; summary: Message } {
	// A host-triggered pass has no run-scoped WorkingStateManager to carry the
	// summary into a later query. Pin this summary itself: until a future run
	// has rebuilt equivalent state, this message is the only surviving record
	// of what the pass removed.
	const summary = { ...buildCompactionMessage(summaryBody), retain: true }
	return { messages: [...preservedSystem, summary, ...retainedOlder, ...recentMessages], summary }
}

/** Build the state a host-triggered pass is about to replace. */
function populateWorkingState(
	manager: WorkingStateManager,
	messages: readonly Message[],
	config: CompactionConfig,
): void {
	let firstUser = true
	const toolNames = new Map<string, string>()

	for (const message of messages) {
		switch (message.role) {
			case 'user':
				extractFromUserMessage(manager, message.content, firstUser)
				firstUser = false
				break
			case 'assistant':
				if (message.content) extractFromAssistantMessage(manager, message.content, config)
				for (const call of message.toolCalls ?? []) {
					toolNames.set(call.id, call.function.name)
					extractFromToolCall(manager, call.function.name, call.function.arguments)
				}
				break
			case 'tool':
				extractFromToolResult(
					manager,
					toolNames.get(message.toolCallId) ?? 'tool',
					toolResultToText(message.content),
					message.isError === true,
				)
				break
			case 'system':
				break
		}
	}
}

/**
 * Compact a history now, whatever its size.
 *
 * Returns `null` when there is nothing to shed — not a zero-shed result.
 * A caller has to be able to tell "I compacted and it did nothing" from "I
 * compacted", and an outcome object reporting zero is the shape that gets
 * logged as a successful pass and shown to a user as work done.
 */
export async function compactNow(input: CompactNowInput): Promise<CompactionResult | null> {
	admitManualCompaction(input)
	const window = resolveContextWindow(
		input.contextWindowTokens ?? input.config.contextWindowTokens,
		input.model,
	)

	// `force` because a host asked. The threshold exists to decide whether an
	// automatic pass is worth its model call; somebody clicking "compact"
	// has already answered that question.
	const plan = planCompaction({
		messages: input.messages,
		config: input.config,
		contextWindowTokens: window.tokens,
		estimatedTokens: window.tokens,
		force: true,
		allowNoSystemFloor: true,
		skipToolResultClear: true,
	})
	if (plan.kind !== 'plan') return null

	const retained = findRetainedIndices(input.messages)
	const retainedOlder = plan.olderMessages.filter((_, offset) =>
		retained.has(plan.systemMessages.length + offset),
	)
	const preservedSystem = preservedSystemFloor(plan.systemMessages)
	const projectedLength =
		preservedSystem.length + 1 + retainedOlder.length + plan.recentMessages.length
	// Decide before building a summary (and before a possible verifier call).
	// A pinned older message remains verbatim, so replacing one removable
	// message with one summary has shed nothing and must be reported as a no-op.
	if (input.messages.length - projectedLength < 1) return null

	const manager = new WorkingStateManager(input.config)
	populateWorkingState(manager, plan.olderMessages, input.config)
	const body = await buildVerifiedSummary(
		manager,
		[...plan.olderMessages],
		input.provider,
		input.config,
		undefined,
		input.model ?? '',
		{ signal: input.signal, streamIdleTimeoutMs: input.streamIdleTimeoutMs },
	)

	const { messages, summary } = splice(preservedSystem, body, retainedOlder, plan.recentMessages)
	return { messages, shed: input.messages.length - messages.length, summary }
}

export interface CompactRegionInput extends CompactNowInput {
	/** First index to summarise, inclusive. */
	readonly start: number
	/** One past the last index to summarise. */
	readonly end: number
}

/**
 * Compact exactly the span a host chose, or refuse.
 *
 * REFUSES rather than repairing. Snapping a bad edge to the nearest safe
 * one would return a different span than the one asked for, and the caller
 * — who picked those indices from something they were looking at — has no
 * way to notice: the result is a valid history that summarised the wrong
 * messages. `refuse-do-not-degrade`, and the offending index is named so
 * the caller can move it themselves.
 */
export async function compactRegion(input: CompactRegionInput): Promise<CompactionResult | null> {
	admitManualCompaction(input)
	const { messages, start, end } = input

	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > messages.length) {
		throw new NamzuError({
			code: 'invalid_config',
			message: `compactRegion: [${start}, ${end}) is not a range inside a history of ${messages.length} messages.`,
			details: { start, end, length: messages.length },
			retryable: false,
		})
	}
	if (end - start < 1) return null

	for (const [label, index] of [
		['start', start],
		['end', end],
	] as const) {
		// `findSafeTrimIndex` returns the nearest index that does NOT split a
		// tool-call pair. Anything other than the index itself means this edge
		// sits between an assistant's `tool_use` and its `tool_result`, and
		// cutting there leaves the provider a result with no matching call —
		// which it rejects on the next turn.
		if (findSafeTrimIndex(messages as Message[], index) !== index) {
			throw new NamzuError({
				code: 'invalid_config',
				message: `compactRegion: ${label} index ${index} splits a tool_use/tool_result pair. Move it to a boundary between turns.`,
				details: { [label]: index, start, end },
				retryable: false,
			})
		}
	}

	const retained = findRetainedIndices(messages)
	const retainedSelected = messages
		.slice(start, end)
		.filter((_, offset) => retained.has(start + offset))
	// The replacement summary itself costs one slot. If the selected region
	// contains no additional removable message, the honest result is a no-op
	// and no verifier/provider work is authorized.
	if (end - start - retainedSelected.length - 1 < 1) return null

	const manager = new WorkingStateManager(input.config)
	populateWorkingState(manager, messages.slice(start, end), input.config)
	const body = await buildVerifiedSummary(
		manager,
		messages.slice(start, end),
		input.provider,
		input.config,
		undefined,
		input.model ?? '',
		{ signal: input.signal, streamIdleTimeoutMs: input.streamIdleTimeoutMs },
	)

	// Same cross-run ownership as compactNow: a selected region has been
	// replaced outside a run, so its only surviving account is pinned.
	const summary = { ...buildCompactionMessage(body), retain: true }
	const out = [...messages.slice(0, start), summary, ...retainedSelected, ...messages.slice(end)]

	// Checked after the splice, not only before it. The edges being
	// individually safe does not make the RESULT valid — a span whose
	// interior held one half of a pair straddling `start` would pass both
	// edge checks and produce an orphan.
	const dangling = findDanglingMessages(out)
	if (!dangling.isValid) {
		throw new NamzuError({
			code: 'invalid_config',
			message: `compactRegion: summarising [${start}, ${end}) would leave an unmatched tool result. Widen the span to cover the whole exchange.`,
			details: { start, end },
			retryable: false,
		})
	}

	return { messages: out, shed: messages.length - out.length, summary }
}
