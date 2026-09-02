/**
 * The working set: which messages stay whole for the next call.
 *
 * Given every message's salience, choose the cheapest actions that bring
 * the estimated context under a target, lowest salience per token first:
 *
 *   clear   empty a tool result's body to the same placeholder the stale
 *           pass uses, so a result the model turns out to need is one
 *           call away rather than lost;
 *   stub    cut an assistant narration to its first sentence — the
 *           decision survives, the paragraph around it does not.
 *
 * Nothing protected is touched, and a message is never removed: the
 * shape of the conversation — every `tool_use` beside its `tool_result`,
 * every turn boundary — is exactly what it was, which is what makes this
 * safe to run on every iteration. Folding a span into the structured
 * state and summarising stay with the existing plan, which runs after
 * this when the target could not be reached. Pure, like the rest of the
 * compaction arithmetic.
 */

import { CHARS_PER_TOKEN } from '../../constants/limits.js'
import type { AssistantMessage, Message, ToolMessage } from '../../types/message/index.js'
import { clearToolResult, isClearedToolResult } from '../tool-result-editing.js'
import type { ScoredMessage } from './score.js'

export interface WorkingSetAction {
	readonly kind: 'clear' | 'stub'
	readonly index: number
	readonly charsReclaimed: number
}

export interface WorkingSetPlan {
	readonly messages: Message[]
	readonly actions: readonly WorkingSetAction[]
	readonly clearedCount: number
	readonly stubbedCount: number
	readonly charsReclaimed: number
	readonly reclaimedTokens: number
	/** Whether the actions brought the estimate under the target. */
	readonly reachedTarget: boolean
}

export interface WorkingSetOptions {
	readonly estimatedTokens: number
	readonly targetTokens: number
	/** Tool results smaller than this are not worth a placeholder. */
	readonly minToolResultChars?: number
	/** Assistant narrations shorter than this keep their whole text. */
	readonly minNarrationChars?: number
	/** Tools whose results are never cleared. */
	readonly preserveTools?: readonly string[]
	/**
	 * A message the goal names or a later turn cited is not evicted to
	 * reach the target while it scores above this fraction of the most
	 * salient evictable message. A strict target evicted the one result
	 * the goal named to shave the last few tokens — an eval watched it
	 * happen — and a pass that stops short and says so is the better
	 * answer: the trigger threshold still guards the hard limit.
	 */
	readonly keepAboveFraction?: number
}

const STUB_MARK = '… (elided'

function firstSentence(text: string): string {
	const match = /^[\s\S]*?[.!?](?=\s|$)/u.exec(text.trim())
	return (match ? match[0] : (text.trim().split('\n')[0] ?? '')).slice(0, 240)
}

export function isStubbedNarration(content: unknown): boolean {
	return typeof content === 'string' && content.includes(STUB_MARK)
}

export function planWorkingSet(
	messages: readonly Message[],
	scored: readonly ScoredMessage[],
	options: WorkingSetOptions,
): WorkingSetPlan {
	const minTool = options.minToolResultChars ?? 1_000
	const minNarration = options.minNarrationChars ?? 240
	const preserve = new Set(options.preserveTools ?? [])
	const toolNameByCallId = new Map<string, string>()
	for (const m of messages) {
		if (m.role !== 'assistant') continue
		for (const call of (m as AssistantMessage).toolCalls ?? []) {
			toolNameByCallId.set(call.id, call.function.name)
		}
	}

	// Ordered by salience, not salience per token. Per token was the plan's
	// first answer and it evicts the wrong thing: a large result the goal
	// names loses to a small one it does not, because size divides the
	// score. Among equals the larger goes first, which is where the tokens
	// are.
	type Candidate = {
		readonly index: number
		readonly kind: 'clear' | 'stub'
		readonly salience: number
		readonly tokens: number
		/** Named by the goal or cited by a later turn: what the floor protects. */
		readonly goalBound: boolean
	}
	const candidates: Candidate[] = []
	for (const s of scored) {
		if (s.protected !== null || s.tokens === 0) continue
		const m = messages[s.index] as Message
		if (m.role === 'tool') {
			const tool = m as ToolMessage
			if (tool.isError || isClearedToolResult(tool.content)) continue
			if (preserve.has(toolNameByCallId.get(tool.toolCallId) ?? '')) continue
			if (s.tokens * CHARS_PER_TOKEN < minTool) continue
			candidates.push({
				index: s.index,
				kind: 'clear',
				salience: s.salience,
				tokens: s.tokens,
				goalBound: s.relevance >= 0.5 || s.utility >= 1,
			})
		} else if (m.role === 'assistant' && !Array.isArray((m as AssistantMessage).toolCalls)) {
			const text = typeof m.content === 'string' ? m.content : ''
			if (text.length < minNarration || isStubbedNarration(text)) continue
			candidates.push({
				index: s.index,
				kind: 'stub',
				salience: s.salience,
				tokens: s.tokens,
				goalBound: s.relevance >= 0.5 || s.utility >= 1,
			})
		}
	}
	candidates.sort((a, b) => a.salience - b.salience || b.tokens - a.tokens || a.index - b.index)
	const maxSalience = candidates.reduce((m, c) => Math.max(m, c.salience), Number.NEGATIVE_INFINITY)
	const floor = maxSalience * (options.keepAboveFraction ?? 0.5)

	const next = [...messages]
	const actions: WorkingSetAction[] = []
	let charsReclaimed = 0
	let clearedCount = 0
	let stubbedCount = 0
	const excess = () =>
		options.estimatedTokens - Math.ceil(charsReclaimed / CHARS_PER_TOKEN) - options.targetTokens
	for (const candidate of candidates) {
		if (excess() <= 0) break
		// The floor guards what the goal names or a later turn used, not
		// every above-average message: a run of look-alike dumps must still
		// be evicted from the bottom when the target asks for it.
		if (candidate.goalBound && candidate.salience > floor && candidate.salience > 0) continue
		const m = next[candidate.index] as Message
		if (candidate.kind === 'clear') {
			const tool = m as ToolMessage
			const cleared = clearToolResult(tool, toolNameByCallId.get(tool.toolCallId) ?? 'unknown')
			if (cleared.charsReclaimed <= 0) continue
			next[candidate.index] = cleared.message
			charsReclaimed += cleared.charsReclaimed
			clearedCount += 1
			actions.push({
				kind: 'clear',
				index: candidate.index,
				charsReclaimed: cleared.charsReclaimed,
			})
		} else {
			const text = m.content as string
			const stub = `${firstSentence(text)} ${STUB_MARK}; ${(text.length - firstSentence(text).length).toLocaleString('en-US')} characters of narration)`
			const reclaimed = text.length - stub.length
			if (reclaimed <= 0) continue
			next[candidate.index] = { ...(m as AssistantMessage), content: stub }
			charsReclaimed += reclaimed
			stubbedCount += 1
			actions.push({ kind: 'stub', index: candidate.index, charsReclaimed: reclaimed })
		}
	}
	return {
		messages: next,
		actions,
		clearedCount,
		stubbedCount,
		charsReclaimed,
		reclaimedTokens: Math.ceil(charsReclaimed / CHARS_PER_TOKEN),
		reachedTarget: excess() <= 0,
	}
}
