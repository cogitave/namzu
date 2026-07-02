/**
 * Regression test for the ses_055 Layer-B SDK seam (#104):
 *
 *   1. **Compaction FIRES** under a small `contextWindowTokens` even with the
 *      run-level `tokenBudget = 0` (UNLIMITED) — proving the F1 fix repointed
 *      BOTH the `<= 0` guard AND the divisor, closing the silent-no-op trap.
 *   2. **The pinned working-memory slot SURVIVES** the compaction pass (it is a
 *      leading system message → preserved by header identity).
 *   3. **No premature stop** from `tokenBudget = 0` alone: with NO
 *      `contextWindowTokens`, the same overflowing run does NOT compact (the
 *      legacy fallback), so consumers that never set the new field are
 *      byte-identical.
 *
 * The test drives `refreshWorkingMemory` (to pin the slot) then
 * `runCompactionCheck` directly against a mock `IterationContext`, which is the
 * exact sequence the iteration loop runs each turn.
 */

import { describe, expect, it, vi } from 'vitest'

import { findDanglingMessages } from '../../../../compaction/dangling.js'
import { WorkingStateManager } from '../../../../compaction/manager.js'
import { CompactionConfigSchema } from '../../../../config/runtime.js'
import type { RunId } from '../../../../types/ids/index.js'
import {
	type Message,
	createAssistantMessage,
	createSystemMessage,
	createToolMessage,
	createUserMessage,
} from '../../../../types/message/index.js'
import type { Logger } from '../../../../utils/logger.js'
import { runCompactionCheck } from './compaction.js'
import type { IterationContext } from './context.js'
import { WORKING_MEMORY_HEADER, refreshWorkingMemory } from './working-memory.js'

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

/** A long string so a handful of messages overflow a small context window. */
const FILLER = 'x'.repeat(200)

function buildOverflowingMessages(): Message[] {
	const msgs: Message[] = [createSystemMessage(`STATIC SYSTEM PROMPT ${FILLER}`, 'cache')]
	for (let i = 0; i < 8; i++) {
		msgs.push(createUserMessage(`user turn ${i} ${FILLER}`))
		msgs.push(createAssistantMessage(`assistant turn ${i} ${FILLER}`))
	}
	return msgs
}

function makeCtx(opts: {
	messages: Message[]
	contextWindowTokens?: number
	workingMemoryProvider?: IterationContext['workingMemoryProvider']
}): IterationContext {
	const config = CompactionConfigSchema.parse({
		strategy: 'structured',
		llmVerification: false,
		...(opts.contextWindowTokens !== undefined
			? { contextWindowTokens: opts.contextWindowTokens }
			: {}),
	})
	const manager = new WorkingStateManager(config)
	// Seed a couple of slots so serializeState produces non-trivial output.
	manager.addDecision('built the report as .docx')

	return {
		runConfig: { tokenBudget: 0 }, // UNLIMITED cumulative cost cap
		compactionConfig: config,
		workingStateManager: manager,
		workingMemoryProvider: opts.workingMemoryProvider,
		log: makeLogger(),
		runMgr: {
			id: 'run_1' as RunId,
			currentIteration: 3,
			messages: opts.messages,
		},
	} as unknown as IterationContext
}

const WM_BLOCK =
	'ARTIFACTS\n  • report.docx · Word document · 48.2 KB · imp:H\n       path: /mnt/user-data/outputs/report.docx'

describe('Layer-B compaction seam (ses_055 #104)', () => {
	it('FIRES on small contextWindowTokens with tokenBudget=0 AND preserves the pinned WM slot', async () => {
		const messages = buildOverflowingMessages()
		const ctx = makeCtx({
			messages,
			contextWindowTokens: 100,
			workingMemoryProvider: () => WM_BLOCK,
		})

		await refreshWorkingMemory(ctx)
		// The slot is pinned as the last leading system message (index 1).
		expect(messages[1]?.role).toBe('system')
		expect(messages[1]?.content?.startsWith(WORKING_MEMORY_HEADER)).toBe(true)

		const before = messages.length
		await runCompactionCheck(ctx)

		// (1) compaction fired: a [COMPACTED CONTEXT] message appeared and the
		// transcript shrank.
		expect(messages.length).toBeLessThan(before)
		expect(messages.some((m) => m.content?.includes('[COMPACTED CONTEXT]'))).toBe(true)

		// (2) the pinned working-memory slot survived by header identity.
		const wm = messages.filter(
			(m) => m.role === 'system' && m.content?.startsWith(WORKING_MEMORY_HEADER),
		)
		expect(wm).toHaveLength(1)
		expect(wm[0]?.content).toContain('report.docx')
	})

	it('does NOT compact when contextWindowTokens is absent and tokenBudget=0 (byte-identical fallback)', async () => {
		const messages = buildOverflowingMessages()
		const ctx = makeCtx({ messages })

		const before = messages.length
		await runCompactionCheck(ctx)

		// budget = tokenBudget = 0 → guard returns; no compaction, no mutation.
		expect(messages.length).toBe(before)
		expect(messages.some((m) => m.content?.includes('[COMPACTED CONTEXT]'))).toBe(false)
	})

	it('removes the slot when the provider returns an empty block', async () => {
		const messages = buildOverflowingMessages()
		const ctx = makeCtx({
			messages,
			contextWindowTokens: 100,
			workingMemoryProvider: () => WM_BLOCK,
		})
		await refreshWorkingMemory(ctx)
		expect(messages.some((m) => m.content?.startsWith(WORKING_MEMORY_HEADER))).toBe(true)

		// Same transcript, provider now returns blank ⇒ the slot is removed.
		const blankCtx = makeCtx({
			messages,
			contextWindowTokens: 100,
			workingMemoryProvider: () => '   ',
		})
		await refreshWorkingMemory(blankCtx)
		expect(messages.some((m) => m.content?.startsWith(WORKING_MEMORY_HEADER))).toBe(false)
	})

	it('keeps the prior slot when the provider throws (failure-isolated)', async () => {
		const messages = buildOverflowingMessages()
		const ctx = makeCtx({
			messages,
			contextWindowTokens: 100,
			workingMemoryProvider: () => WM_BLOCK,
		})
		await refreshWorkingMemory(ctx)

		const throwingCtx = makeCtx({
			messages,
			contextWindowTokens: 100,
			workingMemoryProvider: () => {
				throw new Error('provider boom')
			},
		})
		await refreshWorkingMemory(throwingCtx)
		// Prior slot retained; run not broken.
		expect(messages.some((m) => m.content?.startsWith(WORKING_MEMORY_HEADER))).toBe(true)
	})

	it('does NOT orphan a tool_result when the recent-window cut splits a tool pair (C1)', async () => {
		// keepRecentMessages defaults to 4. Lay the transcript out so the NAIVE
		// cut (length - 4 = index 5) lands right AFTER the assistant-with-toolCall
		// (index 4) but BEFORE... no — exactly ON its tool result (index 5), which
		// a naive slice would keep in the recent window while dropping the
		// assistant into the summarized older set → an orphaned tool_result at the
		// head of the recent window → Anthropic 400. The fix snaps keepStart
		// forward past the complete pair.
		const toolCall = {
			id: 't1',
			type: 'function' as const,
			function: { name: 'read', arguments: '{}' },
		}
		const messages: Message[] = [
			createSystemMessage(`STATIC SYSTEM PROMPT ${FILLER}`, 'cache'),
			createUserMessage(`user 0 ${FILLER}`),
			createAssistantMessage(`assistant 0 ${FILLER}`),
			createUserMessage(`user 1 ${FILLER}`),
			createAssistantMessage(`calling a tool ${FILLER}`, [toolCall]), // idx 4
			createToolMessage(`tool result ${FILLER}`, 't1'), // idx 5 — naive recent[0]
			createAssistantMessage(`assistant 2 ${FILLER}`),
			createUserMessage(`user 3 ${FILLER}`),
			createAssistantMessage(`assistant 3 ${FILLER}`),
		]
		const ctx = makeCtx({ messages, contextWindowTokens: 100 })

		await runCompactionCheck(ctx)

		// Compaction fired.
		expect(messages.some((m) => m.content?.includes('[COMPACTED CONTEXT]'))).toBe(true)
		// The surviving transcript has NO dangling tool pair — the tool result
		// whose assistant was summarized away was moved into the older set too,
		// so no orphaned tool_result remains to 400 the next provider turn.
		expect(findDanglingMessages(messages).isValid).toBe(true)
		// And a `tool` message never leads the recent window.
		const firstNonSystem = messages.find((m) => m.role !== 'system')
		expect(firstNonSystem?.role).not.toBe('tool')
	})
})
