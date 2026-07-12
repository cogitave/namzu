/**
 * Current-code invariants asserted (2026-07-12, ses_015 Phase C):
 *
 *   `runCompactionCheck` proactive cut safety. The boundary between the
 *   summarised "older" region and the preserved "recent" region is computed
 *   as `findSafeTrimIndex(messages, messages.length - keepRecentMessages)`,
 *   so a tool call/result pair that straddles the naive cut is pushed wholly
 *   into the older (summarised) region rather than leaving an orphaned tool
 *   result at the head of the recent region.
 *
 *   - After compaction, the resulting history is dangling-free
 *     (`findDanglingMessages(...).isValid === true`).
 *   - The leading system prefix is preserved and a single summary system
 *     message (`[COMPACTED CONTEXT] ...`) is inserted after it.
 *   - Early returns (unchanged): no `compactionConfig`, `strategy:'disabled'`,
 *     no `workingStateManager`, usage below `triggerThreshold`, too few
 *     messages, or no leading system message → messages untouched.
 *
 *   This test uses `llmVerification: false` so the summary is produced by the
 *   pure `serializeState` path (no provider call).
 *
 * Additional invariants asserted (2026-07-12, ses_015 fix-batch):
 *   - The cut is a bounded DOWNWARD search for the largest safe cut <= naive, so
 *     the recent window never shrinks below keepRecentMessages (the latest user
 *     turn is always kept raw) and a straddling tool pair is kept wholly in the
 *     recent window rather than summarised away.
 *   - When the naive cut lands at or inside the leading system run (large
 *     keepRecentMessages, small history), compaction is skipped: no system
 *     duplication and no history growth.
 *   - Prior [COMPACTED CONTEXT] summary text is carried into the fresh summary so
 *     a fact captured only in an earlier summary survives a second compaction.
 */
import { describe, expect, it, vi } from 'vitest'
import { findDanglingMessages } from '../../../../compaction/dangling.js'
import type { CompactionConfig } from '../../../../config/runtime.js'
import type { RunId } from '../../../../types/ids/index.js'
import type { Message } from '../../../../types/message/index.js'
import type { Logger } from '../../../../utils/logger.js'
import { COMPACTION_HEADER, runCompactionCheck } from './compaction.js'
import type { IterationContext } from './context.js'

function makeLogger(): Logger {
	const self = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		child: vi.fn(),
	} as unknown as Logger
	;(self as { child: (ctx: unknown) => Logger }).child = vi.fn(() => self)
	return self
}

function emptyWorkingState() {
	return {
		task: '',
		plan: [],
		files: new Map(),
		decisions: [],
		failures: [],
		discoveries: [],
		environment: [],
		toolResults: [],
		userRequirements: [],
		assistantNotes: [],
	}
}

function makeCtx(messages: Message[], config: Partial<CompactionConfig>): IterationContext {
	return {
		provider: {} as never,
		runConfig: { tokenBudget: 1000 },
		runMgr: { id: 'run_1' as RunId, messages },
		log: makeLogger(),
		compactionConfig: {
			strategy: 'structured',
			triggerThreshold: 0,
			resetThreshold: 0.4,
			keepRecentMessages: 3,
			maxToolResults: 30,
			maxListSize: 25,
			llmVerification: false,
			llmVerificationMaxTokens: 2048,
			richStateThreshold: 15,
			convoTextBudget: 12_000,
			maxSentencesPerTurn: 5,
			maxCharsPerNote: 500,
			maxCharsPerRequirement: 300,
			maxCharsPerTask: 400,
			...config,
		} as CompactionConfig,
		workingStateManager: {
			slotCount: () => 0,
			getState: () => emptyWorkingState(),
		},
	} as unknown as IterationContext
}

describe('runCompactionCheck — proactive cut-point safety', () => {
	it('does not sever a tool pair straddling the naive keepStart', async () => {
		// keepRecentMessages = 3 → naive keepStart = length(8) - 3 = 5, which points
		// at the tool result at index 5 whose assistant (index 4) sits before the cut.
		const messages: Message[] = [
			{ role: 'system', content: 'system prompt' },
			{ role: 'user', content: 'u1' },
			{
				role: 'assistant',
				content: null,
				toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'n', arguments: '{}' } }],
			},
			{ role: 'tool', content: 'r1', toolCallId: 'call-1' },
			{
				role: 'assistant',
				content: null,
				toolCalls: [{ id: 'call-2', type: 'function', function: { name: 'n', arguments: '{}' } }],
			},
			{ role: 'tool', content: 'r2', toolCallId: 'call-2' },
			{ role: 'user', content: 'u2' },
			{ role: 'user', content: 'u3' },
		]

		const ctx = makeCtx(messages, {})
		await runCompactionCheck(ctx)

		const result = ctx.runMgr.messages
		// No dangling pairs introduced by the split.
		expect(findDanglingMessages(result).isValid).toBe(true)
		// The downward search moves the cut BEFORE the straddling pair, so the pair
		// (assistant+tool for call-2) is kept whole in the recent window rather than
		// severed or summarised away.
		const keptTool = result.find(
			(m): m is Message =>
				m.role === 'tool' && (m as { toolCallId?: string }).toolCallId === 'call-2',
		)
		expect(keptTool).toBeDefined()
		// System prefix preserved + one summary message inserted after it.
		expect(result[0]?.role).toBe('system')
		expect(result[0]?.content).toBe('system prompt')
		expect(result[1]?.role).toBe('system')
		expect(result[1]?.content).toContain('[COMPACTED CONTEXT]')
		// The latest user turns are kept raw (never summarised away).
		expect(result.at(-2)?.content).toBe('u2')
		expect(result.at(-1)?.content).toBe('u3')
	})

	it('leaves messages untouched when usage is below the trigger threshold', async () => {
		const messages: Message[] = [
			{ role: 'system', content: 'system prompt' },
			{ role: 'user', content: 'u1' },
			{ role: 'assistant', content: 'a1' },
			{ role: 'user', content: 'u2' },
			{ role: 'assistant', content: 'a2' },
			{ role: 'user', content: 'u3' },
		]
		const before = messages.slice()

		const ctx = makeCtx(messages, { triggerThreshold: 1 })
		await runCompactionCheck(ctx)

		expect(ctx.runMgr.messages).toEqual(before)
	})

	it('skips compaction (no system dup, no growth) when naive cut lands in the system run', async () => {
		// 3 leading system messages + 9 non-system, keepRecentMessages=10 → naive =
		// 12 - 10 = 2, which is <= systemMessages.length (3). Compacting would only
		// duplicate a system message and grow the history, so it must be skipped.
		const messages: Message[] = [
			{ role: 'system', content: 'system prompt one with enough text to matter here' },
			{ role: 'system', content: 'persona system message with a fair amount of content' },
			{ role: 'system', content: 'skills system message carrying instructions and text' },
		]
		for (let i = 0; i < 9; i++) {
			messages.push({
				role: 'user',
				content: `message ${i} with a long body of text to fill space`,
			})
		}
		const before = messages.slice()

		const ctx = makeCtx(messages, { keepRecentMessages: 10, triggerThreshold: 0 })
		await runCompactionCheck(ctx)

		// Untouched: no duplicated system prompt, no inserted summary, no growth.
		expect(ctx.runMgr.messages).toEqual(before)
		expect(
			ctx.runMgr.messages.filter((m) => (m.content ?? '').startsWith(COMPACTION_HEADER)),
		).toHaveLength(0)
	})

	it('carries a prior summary fact into the fresh summary on a second compaction', async () => {
		// A fact captured only inside an earlier [COMPACTED CONTEXT] summary must
		// survive anti-stacking (the prior summary is stripped and replaced).
		const messages: Message[] = [
			{ role: 'system', content: 'system prompt' },
			{
				role: 'system',
				content: `${COMPACTION_HEADER}\n\nUNIQUE_FACT_ABC123 must be preserved across compactions`,
			},
			{ role: 'user', content: 'u1 with a long body of text to have something to summarise' },
			{ role: 'assistant', content: 'a1 with a long body of text to have something to summarise' },
			{ role: 'user', content: 'u2 with a long body of text to have something to summarise' },
			{ role: 'assistant', content: 'a2 with a long body of text to have something to summarise' },
			{ role: 'user', content: 'u3 with a long body of text to have something to summarise' },
		]

		const ctx = makeCtx(messages, {})
		await runCompactionCheck(ctx)

		const result = ctx.runMgr.messages
		const summary = result.find((m) => (m.content ?? '').startsWith(COMPACTION_HEADER))
		expect(summary?.content).toContain('UNIQUE_FACT_ABC123')
		// Anti-stacking still holds: exactly one summary after the pass.
		expect(result.filter((m) => (m.content ?? '').startsWith(COMPACTION_HEADER))).toHaveLength(1)
	})
})
