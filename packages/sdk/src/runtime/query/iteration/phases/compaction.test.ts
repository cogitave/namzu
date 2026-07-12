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
 */
import { describe, expect, it, vi } from 'vitest'
import { findDanglingMessages } from '../../../../compaction/dangling.js'
import type { CompactionConfig } from '../../../../config/runtime.js'
import type { RunId } from '../../../../types/ids/index.js'
import type { Message } from '../../../../types/message/index.js'
import type { Logger } from '../../../../utils/logger.js'
import { runCompactionCheck } from './compaction.js'
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
		// The straddling pair was pushed into the summary; the recent tail has no tool result.
		expect(result.some((m) => m.role === 'tool')).toBe(false)
		// System prefix preserved + one summary message inserted after it.
		expect(result[0]?.role).toBe('system')
		expect(result[0]?.content).toBe('system prompt')
		expect(result[1]?.role).toBe('system')
		expect(result[1]?.content).toContain('[COMPACTED CONTEXT]')
		// Recent tail (the two trailing user messages) preserved.
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
})
