// Current-code invariants asserted (2026-07-12, ses_015 Phase A):
// - reduceMessagesForOverflow is candidate-first: it commits (in-place splice)
//   only when the token estimate strictly shrinks, otherwise returns false and
//   leaves runMgr.messages byte-identical.
// - The fallback path (no compaction config / working state) drops the oldest
//   half of NON-system messages, preserving the leading system run, and adjusts
//   the cut with findSafeTrimIndex so no tool call/result pair is severed and no
//   orphaned tool result leads the kept window.
// - The structured path replaces prior compaction summaries with a single fresh
//   one (anti-stacking): after reduction exactly one system message begins with
//   COMPACTION_HEADER.
//
// Current-code invariants asserted (2026-07-12, ses_015 fix-batch):
// - When the structured candidate cannot shrink (keepRecent >= history, so it
//   re-includes everything plus a summary), reduceMessagesForOverflow CASCADES to
//   the fallback safe-trim, which drops the oldest oversized tool pair; it returns
//   false only when neither candidate shrinks.
//
// Current-code invariants asserted (2026-07-12, ses_015 pre-freeze M2/M3):
// - Anti-stacking scans the WHOLE history, not just the leading system run: a
//   summary that ended up interleaved (possible after a forced reduction, which
//   keeps a halved recent window) is carried into the fresh summary and dropped,
//   so exactly one COMPACTION_HEADER message survives a reduction.
// - The fallback trim halves the count of ACTUAL non-system messages, so
//   interleaved system messages cannot inflate the count and push the cut past
//   the live conversation.
import { describe, expect, it, vi } from 'vitest'
import { WorkingStateManager } from '../../../../compaction/manager.js'
import { type CompactionConfig, CompactionConfigSchema } from '../../../../config/runtime.js'
import {
	type Message,
	createAssistantMessage,
	createSystemMessage,
	createToolMessage,
	createUserMessage,
} from '../../../../types/message/index.js'
import type { Logger } from '../../../../utils/logger.js'
import { COMPACTION_HEADER, reduceMessagesForOverflow } from './compaction.js'
import type { IterationContext } from './context.js'

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function makeCtx(
	messages: Message[],
	opts?: { compactionConfig?: CompactionConfig; manager?: WorkingStateManager },
): IterationContext {
	return {
		runMgr: { id: 'run_test', messages },
		compactionConfig: opts?.compactionConfig,
		workingStateManager: opts?.manager,
		log: makeLogger(),
	} as unknown as IterationContext
}

const DEFAULT_COMPACTION = CompactionConfigSchema.parse({})

describe('reduceMessagesForOverflow — fallback trim', () => {
	it('drops the oldest half of non-system messages, preserving leading system', () => {
		const messages: Message[] = [
			createSystemMessage('system anchor with enough characters to matter'),
			createUserMessage('user one with a reasonably long body of text here'),
			createAssistantMessage('assistant one with a long response body of text'),
			createUserMessage('user two with a reasonably long body of text here'),
			createAssistantMessage('assistant two with a long response body of text'),
			createUserMessage('user three with a reasonably long body of text here'),
		]
		const ctx = makeCtx(messages)

		expect(reduceMessagesForOverflow(ctx)).toBe(true)
		// 5 non-system → drop floor(5/2)=2 → keep [system, user2, assistant2, user3]
		expect(messages).toHaveLength(4)
		expect(messages[0]?.role).toBe('system')
		expect(messages[1]?.content).toContain('user two')
	})

	it('returns false and leaves history untouched when it cannot shrink', () => {
		const messages: Message[] = [
			createSystemMessage('system anchor'),
			createUserMessage('only one non-system message'),
		]
		const ctx = makeCtx(messages)
		const snapshot = [...messages]

		expect(reduceMessagesForOverflow(ctx)).toBe(false)
		expect(messages).toEqual(snapshot)
	})

	it('never leaves an orphaned tool result at the head of the kept window', () => {
		const messages: Message[] = [
			createSystemMessage('system anchor with enough characters to matter here'),
			createUserMessage('user one with a reasonably long body of text present'),
			createAssistantMessage(null, [
				{ id: 'call_x', type: 'function', function: { name: 'foo', arguments: '{}' } },
			]),
			createToolMessage('tool result for call_x with a fair amount of content', 'call_x'),
			createUserMessage('user two with a reasonably long body of text present here'),
			createAssistantMessage('assistant two with a long response body of characters'),
		]
		const ctx = makeCtx(messages)

		expect(reduceMessagesForOverflow(ctx)).toBe(true)
		expect(messages[0]?.role).toBe('system')
		// No orphaned tool result at the head of the kept (post-system) window.
		expect(messages[1]?.role).not.toBe('tool')
	})
})

describe('reduceMessagesForOverflow — structured anti-stacking', () => {
	it('replaces prior compaction summaries with a single fresh summary', () => {
		const manager = new WorkingStateManager(DEFAULT_COMPACTION)
		manager.setTask('the ongoing task being tracked in working state')
		manager.addDiscovery('a discovery worth keeping in the compacted state')

		const priorSummaryBody = 'old serialized state '.repeat(40)
		const messages: Message[] = [
			createSystemMessage('true system anchor prompt with instructions'),
			createSystemMessage(`${COMPACTION_HEADER}\n\n${priorSummaryBody}`),
			createUserMessage('user one with a long body of text present in history'),
			createAssistantMessage('assistant one with a long response body of text here'),
			createUserMessage('user two with a long body of text present in history'),
			createAssistantMessage('assistant two with a long response body of text here'),
			createUserMessage('user three with a long body of text present in history'),
		]
		const ctx = makeCtx(messages, { compactionConfig: DEFAULT_COMPACTION, manager })

		expect(reduceMessagesForOverflow(ctx)).toBe(true)
		const summaryCount = messages.filter((m) =>
			(m.content ?? '').startsWith(COMPACTION_HEADER),
		).length
		expect(summaryCount).toBe(1)
		expect(messages[0]?.content).toContain('true system anchor')
	})
})

describe('reduceMessagesForOverflow — anti-stacking reaches interleaved summaries', () => {
	it('drops a prior summary that ended up inside the recent window', () => {
		// A forced reduction keeps a halved recent window, so a summary an earlier
		// pass inserted can end up sitting INSIDE it rather than at the head. The
		// strip only ever examined the leading system run, so that copy survived and
		// the next pass stacked a second summary on top of it (pre-freeze M2).
		const manager = new WorkingStateManager(DEFAULT_COMPACTION)
		manager.setTask('the ongoing task being tracked in working state')
		manager.addDiscovery('a discovery worth keeping in the compacted state')

		const messages: Message[] = [
			createSystemMessage('true system anchor prompt with instructions'),
			createUserMessage('user one with a long body of text present in history'),
			createAssistantMessage('assistant one with a long response body of text here'),
			// Interleaved, NOT part of the leading system run.
			createSystemMessage(`${COMPACTION_HEADER}\n\n${'stranded summary body '.repeat(30)}`),
			createUserMessage('user two with a long body of text present in history'),
			createAssistantMessage('assistant two with a long response body of text here'),
			createUserMessage('user three with a long body of text present in history'),
			createAssistantMessage('assistant three with a long response body of text'),
		]
		const ctx = makeCtx(messages, { compactionConfig: DEFAULT_COMPACTION, manager })

		expect(reduceMessagesForOverflow(ctx)).toBe(true)

		const summaries = messages.filter((m) => (m.content ?? '').startsWith(COMPACTION_HEADER))
		expect(summaries).toHaveLength(1)
		// The survivor is the fresh one, and the stranded body was carried into it
		// rather than silently dropped.
		expect(summaries[0]?.content).toContain('stranded summary body')
	})

	it('counts only non-system messages when halving the fallback trim', () => {
		// The fallback cut counted every message after the leading system run,
		// interleaved system messages included. A summary-heavy history therefore
		// inflated the count and pushed the cut past real conversation — far enough,
		// with enough summaries, to summarise away the live user turn (pre-freeze M3).
		const messages: Message[] = [
			createSystemMessage('system anchor with enough characters to matter here'),
			createUserMessage('user one with a reasonably long body of text present'),
			createSystemMessage(`${COMPACTION_HEADER}\n\ninterleaved summary one body text`),
			createSystemMessage(`${COMPACTION_HEADER}\n\ninterleaved summary two body text`),
			createUserMessage('user two with a reasonably long body of text present'),
			createAssistantMessage('assistant two with a long response body of characters'),
			createUserMessage('user three with a reasonably long body of text present'),
		]
		// No working state → fallback trim.
		const ctx = makeCtx(messages)

		expect(reduceMessagesForOverflow(ctx)).toBe(true)

		// 4 non-system messages → drop floor(4/2) = 2 → the cut lands on 'user two',
		// so the two most recent non-system turns survive. Counting raw positions
		// would have said 6 and cut past them.
		expect(messages[0]?.role).toBe('system')
		const kept = messages.slice(1).map((m) => m.content ?? '')
		expect(kept.some((c) => c.includes('user three'))).toBe(true)
		expect(kept.some((c) => c.includes('assistant two'))).toBe(true)
		expect(kept.some((c) => c.includes('user one'))).toBe(false)
	})
})

describe('reduceMessagesForOverflow — structured→trim cascade', () => {
	it('falls back to safe-trim when the structured candidate cannot shrink', () => {
		// keepRecentMessages=10 → structured keepRecent=5 >= the 5-message history,
		// so the structured candidate re-includes everything plus a summary and
		// cannot shrink. The cascade must drop the oversized tool pair via trim.
		const config = CompactionConfigSchema.parse({ keepRecentMessages: 10 })
		const manager = new WorkingStateManager(config)
		manager.setTask('the ongoing task being tracked in working state')
		manager.addDiscovery('a discovery worth keeping in the compacted state')

		const giant = 'x'.repeat(6000)
		const messages: Message[] = [
			createSystemMessage('system anchor with enough characters to matter'),
			createUserMessage('kick off the tool with a reasonably long instruction here'),
			createAssistantMessage(null, [
				{ id: 'call_big', type: 'function', function: { name: 'fetch', arguments: '{}' } },
			]),
			createToolMessage(giant, 'call_big'),
			createAssistantMessage('a short trailing assistant note after the big tool result'),
		]
		const ctx = makeCtx(messages, { compactionConfig: config, manager })

		expect(reduceMessagesForOverflow(ctx)).toBe(true)
		// The oversized tool pair was dropped by the fallback trim.
		expect(messages.some((m) => m.content?.includes(giant))).toBe(false)
		expect(messages[0]?.role).toBe('system')
	})
})
