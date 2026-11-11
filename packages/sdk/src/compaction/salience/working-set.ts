/**
 * The working set: which messages stay whole for the next call.
 *
 * Given every message's salience, choose the cheapest actions that bring
 * the estimated context under a target, lowest salience first, then the
 * larger result among equally salient candidates:
 *
 *   clear   replace a tool result with the same excerpt the stale pass
 *           uses, retaining a saved-artifact pointer when one exists;
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
import { estimateMessageTokens } from '../token-estimate.js'
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

/** What decides whether a message is something the pass may shed at all. */
interface EvictionRules {
	readonly minTool: number
	readonly minNarration: number
	readonly preserve: ReadonlySet<string>
	readonly toolNameByCallId: ReadonlyMap<string, string>
}

function evictionRules(
	messages: readonly Message[],
	options: Pick<WorkingSetOptions, 'minToolResultChars' | 'minNarrationChars' | 'preserveTools'>,
): EvictionRules {
	const toolNameByCallId = new Map<string, string>()
	for (const m of messages) {
		if (m.role !== 'assistant') continue
		for (const call of (m as AssistantMessage).toolCalls ?? []) {
			toolNameByCallId.set(call.id, call.function.name)
		}
	}
	return {
		minTool: options.minToolResultChars ?? 1_000,
		minNarration: options.minNarrationChars ?? 240,
		preserve: new Set(options.preserveTools ?? []),
		toolNameByCallId,
	}
}

/**
 * Whether the pass could clear or stub this message, ignoring only what
 * protection decides (the floor, the recent turns, retained turns, a pair
 * with a protected half) and what the score decides. The one place the
 * eligibility rules live: {@link planWorkingSet} asks it of each unprotected
 * message, and {@link hasEvictableMessage} asks it of every message.
 */
function evictionKind(m: Message, tokens: number, rules: EvictionRules): 'clear' | 'stub' | null {
	if (tokens === 0) return null
	if (m.role === 'tool') {
		const tool = m as ToolMessage
		if (tool.isError || isClearedToolResult(tool.content)) return null
		if (rules.preserve.has(rules.toolNameByCallId.get(tool.toolCallId) ?? '')) return null
		if (tokens * CHARS_PER_TOKEN < rules.minTool) return null
		return 'clear'
	}
	if (m.role === 'assistant' && !Array.isArray((m as AssistantMessage).toolCalls)) {
		const text = typeof m.content === 'string' ? m.content : ''
		if (text.length < rules.minNarration || isStubbedNarration(text)) return null
		return 'stub'
	}
	return null
}

/**
 * A cheap count of whether anything at all is left for the pass to shed:
 * false means {@link planWorkingSet} would return no action whatever the
 * scores are, so scoring can be skipped. It leaves out the two protections
 * that are only a position (the leading system run and the last
 * `keepRecentMessages`); retained turns, tool-call pairs and the goal floor
 * are not looked at. True is therefore only "go and look", and a false is
 * exact.
 */
export function hasEvictableMessage(
	messages: readonly Message[],
	options: Pick<WorkingSetOptions, 'minToolResultChars' | 'minNarrationChars' | 'preserveTools'> & {
		readonly keepRecentMessages: number
	},
): boolean {
	const rules = evictionRules(messages, options)
	let floorEnd = 0
	while (floorEnd < messages.length && messages[floorEnd]?.role === 'system') floorEnd += 1
	const end = Math.max(floorEnd, messages.length - options.keepRecentMessages)
	for (let i = floorEnd; i < end; i += 1) {
		const m = messages[i] as Message
		if (evictionKind(m, estimateMessageTokens(m), rules) !== null) return true
	}
	return false
}

/** The plan of a pass that sheds nothing: every message as it was. */
export function planNothingToShed(
	messages: readonly Message[],
	options: Pick<WorkingSetOptions, 'estimatedTokens' | 'targetTokens'>,
): WorkingSetPlan {
	return {
		messages: [...messages],
		actions: [],
		clearedCount: 0,
		stubbedCount: 0,
		charsReclaimed: 0,
		reclaimedTokens: 0,
		reachedTarget: options.estimatedTokens - options.targetTokens <= 0,
	}
}

export function planWorkingSet(
	messages: readonly Message[],
	scored: readonly ScoredMessage[],
	options: WorkingSetOptions,
): WorkingSetPlan {
	const rules = evictionRules(messages, options)
	const { toolNameByCallId } = rules

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
		if (s.protected !== null) continue
		const m = messages[s.index] as Message
		const kind = evictionKind(m, s.tokens, rules)
		if (kind === null) continue
		candidates.push({
			index: s.index,
			kind,
			salience: s.salience,
			tokens: s.tokens,
			goalBound: s.relevance >= 0.5 || s.utility >= 1,
		})
	}
	candidates.sort((a, b) => a.salience - b.salience || b.tokens - a.tokens || a.index - b.index)
	const maxSalience = candidates.reduce((m, c) => Math.max(m, c.salience), Number.NEGATIVE_INFINITY)
	const floor = maxSalience * (options.keepAboveFraction ?? 0.5)

	const next = [...messages]
	const actions: WorkingSetAction[] = []
	let charsReclaimed = 0
	let reclaimedTokens = 0
	let clearedCount = 0
	let stubbedCount = 0
	const excess = () => options.estimatedTokens - reclaimedTokens - options.targetTokens
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
			const tokenSaving = estimateMessageTokens(tool) - estimateMessageTokens(cleared.message)
			if (tokenSaving <= 0) continue
			next[candidate.index] = cleared.message
			charsReclaimed += cleared.charsReclaimed
			reclaimedTokens += tokenSaving
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
			const stubbed = { ...(m as AssistantMessage), content: stub }
			next[candidate.index] = stubbed
			charsReclaimed += reclaimed
			reclaimedTokens += estimateMessageTokens(m) - estimateMessageTokens(stubbed)
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
		reclaimedTokens,
		reachedTarget: excess() <= 0,
	}
}
