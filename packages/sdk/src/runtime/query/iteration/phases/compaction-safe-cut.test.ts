/**
 * The UNBOUNDED CUT.
 *
 * `runCompactionCheck` snaps the naive recent-window boundary
 * (`messages.length - keepRecentMessages`) FORWARD via `findSafeTrimIndex` so a
 * tool pair is never split. But `findSafeTrimIndex` only ever walks forward, and
 * its leading-`tool`-message skip has no stop short of `messages.length` — so
 * whenever the whole suffix from the naive index to the end is `tool` messages,
 * the cut lands ON `messages.length`, `recentMessages` comes back EMPTY, and
 * `[...preservedSystem, compactionMessage]` replaces the ENTIRE recent window.
 * What is left is a transcript with no non-system message at all.
 *
 * The shape that produces it: ONE assistant turn that fans out
 * `>= keepRecentMessages` parallel tool calls, measured at the START of the next
 * iteration — which is exactly where `runCompactionCheck` runs (iteration/index.ts,
 * after `refreshWorkingMemory`, before the model call), i.e. immediately after
 * those results were appended.
 *
 * The `olderMessages.length < 1` guard at :117 cannot fire: `olderMessages` is
 * the whole transcript in exactly this situation.
 *
 * Symmetrically, when the naive index lands BELOW `systemMessages.length` the
 * cut sits inside the system prefix and the leading prompts are duplicated into
 * `recentMessages`.
 *
 * The invariant these tests pin is the one a cut taken AT OR BELOW naive gives
 * for free: a pass never removes more than the naive cut would, so at least
 * `keepRecentMessages` original messages survive verbatim — or, when no safe cut
 * exists at all, the pass is skipped and the transcript is untouched.
 */

import { describe, expect, it, vi } from 'vitest'

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

/** Long enough that a handful of messages overflow a tiny budget. */
const FILLER = 'x'.repeat(200)

const KEEP_RECENT = 4

function makeCtx(opts: {
	messages: Message[]
	contextWindowTokens?: number
	tokenBudget?: number
}): IterationContext {
	const config = CompactionConfigSchema.parse({
		strategy: 'structured',
		llmVerification: false,
		keepRecentMessages: KEEP_RECENT,
		...(opts.contextWindowTokens !== undefined
			? { contextWindowTokens: opts.contextWindowTokens }
			: {}),
	})
	const manager = new WorkingStateManager(config)
	manager.addDecision('built the report as .docx')

	return {
		runConfig: { tokenBudget: opts.tokenBudget ?? 0 },
		compactionConfig: config,
		workingStateManager: manager,
		log: makeLogger(),
		runMgr: {
			id: 'run_1' as RunId,
			currentIteration: 3,
			messages: opts.messages,
		},
	} as unknown as IterationContext
}

function toolCall(id: string) {
	return { id, type: 'function' as const, function: { name: 'read', arguments: '{}' } }
}

/** How many of the ORIGINAL messages survived the pass, by identity. */
function survivorCount(before: readonly Message[], after: readonly Message[]): number {
	const kept = new Set<Message>(after)
	return before.filter((m) => kept.has(m)).length
}

/**
 * The exact shape the iteration loop holds when `runCompactionCheck` runs: the
 * user's turn, one assistant that fanned out four parallel tool calls, and the
 * four results that just landed. The next thing that happens is the model call —
 * with whatever this function leaves behind.
 */
function buildParallelFanOutTail(): Message[] {
	return [
		createSystemMessage(`STATIC SYSTEM PROMPT ${FILLER}`, 'cache'),
		createUserMessage(`please rename the heading to Q3 ${FILLER}`),
		createAssistantMessage(`reading the sources ${FILLER}`, [
			toolCall('a'),
			toolCall('b'),
			toolCall('c'),
			toolCall('d'),
		]),
		createToolMessage(`result a ${FILLER}`, 'a'),
		createToolMessage(`result b ${FILLER}`, 'b'),
		createToolMessage(`result c ${FILLER}`, 'c'),
		createToolMessage(`result d ${FILLER}`, 'd'),
	]
}

describe('compaction — the unbounded cut', () => {
	it('keeps at least keepRecentMessages messages verbatim when the tail is a parallel tool fan-out', async () => {
		const messages = buildParallelFanOutTail()
		const before = [...messages]
		const ctx = makeCtx({ messages, contextWindowTokens: 100 })

		await runCompactionCheck(ctx)

		expect(survivorCount(before, messages)).toBeGreaterThanOrEqual(KEEP_RECENT)
	})

	it('never leaves a system-only transcript (nothing for the next turn to answer)', async () => {
		const messages = buildParallelFanOutTail()
		const ctx = makeCtx({ messages, contextWindowTokens: 100 })

		await runCompactionCheck(ctx)

		const nonSystem = messages.filter((m) => m.role !== 'system')
		expect(nonSystem.length).toBeGreaterThan(0)
	})

	it('skips the pass, leaving the transcript intact, when no safe cut exists at or below naive', async () => {
		// System prefix, then a single assistant fanning out six parallel calls.
		// Every candidate boundary at or below naive splits that one pair-set, so
		// there is nothing safe to cut to — skipping beats deleting the turn.
		const ids = ['a', 'b', 'c', 'd', 'e', 'f']
		const messages: Message[] = [
			createSystemMessage(`STATIC SYSTEM PROMPT ${FILLER}`, 'cache'),
			createAssistantMessage(`fanning out ${FILLER}`, ids.map(toolCall)),
			...ids.map((id) => createToolMessage(`result ${id} ${FILLER}`, id)),
		]
		const before = [...messages]
		const ctx = makeCtx({ messages, contextWindowTokens: 100 })

		await runCompactionCheck(ctx)

		expect(messages).toEqual(before)
	})

	it('does not duplicate the leading system prompts when the naive cut lands inside them', async () => {
		// Legacy (tokenBudget) path: five leading system messages and only three
		// conversational ones, so naive = 8 - 4 = 4 < systemMessages.length = 5.
		const messages: Message[] = [
			createSystemMessage(`SYS-1 ${FILLER}`, 'cache'),
			createSystemMessage(`SYS-2 ${FILLER}`),
			createSystemMessage(`SYS-3 ${FILLER}`),
			createSystemMessage(`SYS-4 ${FILLER}`),
			createSystemMessage(`SYS-5 UNIQUE-MARKER ${FILLER}`),
			createUserMessage(`user 0 ${FILLER}`),
			createAssistantMessage(`assistant 0 ${FILLER}`),
			createUserMessage(`user 1 ${FILLER}`),
		]
		const ctx = makeCtx({ messages, tokenBudget: 100 })

		await runCompactionCheck(ctx)

		const marker = messages.filter((m) => m.content?.includes('UNIQUE-MARKER'))
		expect(marker).toHaveLength(1)
	})
})
