import { describe, expect, it, vi } from 'vitest'

import { findDanglingMessages } from '../../../../compaction/dangling.js'
import { WorkingStateManager } from '../../../../compaction/manager.js'
import { clearStaleToolResults } from '../../../../compaction/tool-result-editing.js'
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

/**
 * Everything the run protected from compaction was protected by POSITION:
 * the leading system run, the working-memory slot, the last N turns, the
 * most recent tool results. So a standing constraint stated in the MIDDLE
 * of a conversation aged out at the same rate as chatter, and no
 * positional rule could express it.
 */

function makeLogger(): Logger {
	const self = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as unknown as Logger
	;(self as { child: (ctx: unknown) => Logger }).child = vi.fn(() => self)
	return self
}

const FILLER = 'x'.repeat(200)
const CONSTRAINT = 'the account id is 4471; never bill a different one'

function makeCtx(messages: Message[]): IterationContext {
	const config = CompactionConfigSchema.parse({
		strategy: 'structured',
		llmVerification: false,
		contextWindowTokens: 100,
		// Off, so these cases exercise the rebuild rather than being
		// satisfied by the cheap in-place reclaim that runs first.
		clearToolResults: false,
	})
	const manager = new WorkingStateManager(config)
	manager.addDecision('built the report')

	return {
		runConfig: { tokenBudget: 0 },
		compactionConfig: config,
		workingStateManager: manager,
		log: makeLogger(),
		runMgr: {
			id: 'run_1' as RunId,
			currentIteration: 3,
			messages,
			lastPromptTokens: undefined,
			clearLastPromptTokens: () => {},
			accumulateUsage: () => {},
		},
		emitEvent: async () => {},
	} as unknown as IterationContext
}

/** A long run whose middle holds one message worth keeping. */
function longRun(pin: (m: Message) => Message = (m) => m): Message[] {
	const msgs: Message[] = [createSystemMessage(`STATIC SYSTEM PROMPT ${FILLER}`, 'cache')]
	for (let i = 0; i < 8; i++) {
		msgs.push(
			i === 1 ? pin(createUserMessage(CONSTRAINT)) : createUserMessage(`user turn ${i} ${FILLER}`),
		)
		msgs.push(createAssistantMessage(`assistant turn ${i} ${FILLER}`))
	}
	return msgs
}

const pinned = (m: Message): Message => ({ ...m, retain: true })
const asText = (content: unknown): string => (typeof content === 'string' ? content : '')

describe('a message the host marked as never-evictable', () => {
	it('is evicted without the marker', async () => {
		// The premise. Without this the next case proves nothing: the
		// message might simply have been recent enough to survive.
		const messages = longRun()
		await runCompactionCheck(makeCtx(messages))

		expect(messages.some((m) => asText(m.content) === CONSTRAINT)).toBe(false)
	})

	it('survives the pass verbatim', async () => {
		const messages = longRun(pinned)
		await runCompactionCheck(makeCtx(messages))

		expect(messages.some((m) => asText(m.content).includes('[COMPACTED CONTEXT]'))).toBe(true)
		expect(messages.some((m) => asText(m.content) === CONSTRAINT)).toBe(true)
	})

	it('sits after the summary and before the recent window', async () => {
		const messages = longRun(pinned)
		await runCompactionCheck(makeCtx(messages))

		const summary = messages.findIndex((m) => asText(m.content).includes('[COMPACTED CONTEXT]'))
		const kept = messages.findIndex((m) => asText(m.content) === CONSTRAINT)
		const lastTurn = messages.findIndex((m) => asText(m.content).startsWith('assistant turn 7'))

		expect(kept).toBeGreaterThan(summary)
		expect(kept).toBeLessThan(lastTurn)
	})

	it('does not keep the run alive by pinning everything', async () => {
		// The marker is a budget the setter spends, and the pass must still
		// reclaim what was not pinned.
		const messages = longRun(pinned)
		const before = messages.length
		await runCompactionCheck(makeCtx(messages))

		expect(messages.length).toBeLessThan(before)
	})
})

describe('a pinned half of a tool pair', () => {
	function runWithPairs(pinIndex: 'call' | 'result'): Message[] {
		const call = {
			id: 'call_pinned',
			type: 'function' as const,
			function: { name: 'lookup_account', arguments: '{}' },
		}
		const msgs: Message[] = [createSystemMessage(`STATIC SYSTEM PROMPT ${FILLER}`, 'cache')]
		msgs.push(createUserMessage(`user turn 0 ${FILLER}`))
		const assistant = { ...createAssistantMessage(null, [call]) } as Message
		const result = createToolMessage(CONSTRAINT, 'call_pinned') as Message
		msgs.push(
			pinIndex === 'call' ? { ...assistant, retain: true } : assistant,
			pinIndex === 'result' ? { ...result, retain: true } : result,
		)
		for (let i = 1; i < 8; i++) {
			msgs.push(createUserMessage(`user turn ${i} ${FILLER}`))
			msgs.push(createAssistantMessage(`assistant turn ${i} ${FILLER}`))
		}
		return msgs
	}

	it('pulls in the result when the call is pinned', async () => {
		const messages = runWithPairs('call')
		await runCompactionCheck(makeCtx(messages))

		// Half a pair is not a smaller history — a `tool_use` with no
		// `tool_result` is rejected outright on the next turn.
		expect(findDanglingMessages(messages).isValid).toBe(true)
		expect(messages.some((m) => asText(m.content) === CONSTRAINT)).toBe(true)
	})

	it('pulls in the call when the result is pinned', async () => {
		const messages = runWithPairs('result')
		await runCompactionCheck(makeCtx(messages))

		expect(findDanglingMessages(messages).isValid).toBe(true)
		expect(messages.some((m) => m.role === 'assistant' && m.toolCalls?.length)).toBe(true)
	})

	it('pulls in the SIBLING results of a fan-out, not just the pinned one', async () => {
		// The second hop. Pinning one result pulls in its assistant turn,
		// and that turn issued two more calls — an assistant with three
		// calls and one surviving result is the same dangling error in the
		// other direction.
		const calls = ['a', 'b', 'c'].map((suffix) => ({
			id: `call_${suffix}`,
			type: 'function' as const,
			function: { name: `lookup_${suffix}`, arguments: '{}' },
		}))
		const messages: Message[] = [createSystemMessage(`STATIC SYSTEM PROMPT ${FILLER}`, 'cache')]
		messages.push(createUserMessage(`user turn 0 ${FILLER}`))
		messages.push(createAssistantMessage(null, calls) as Message)
		messages.push(
			{ ...(createToolMessage(CONSTRAINT, 'call_a') as Message), retain: true },
			createToolMessage(`sibling b ${FILLER}`, 'call_b') as Message,
			createToolMessage(`sibling c ${FILLER}`, 'call_c') as Message,
		)
		for (let i = 1; i < 8; i++) {
			messages.push(createUserMessage(`user turn ${i} ${FILLER}`))
			messages.push(createAssistantMessage(`assistant turn ${i} ${FILLER}`))
		}

		await runCompactionCheck(makeCtx(messages))

		expect(findDanglingMessages(messages).isValid).toBe(true)
		expect(messages.filter((m) => m.role === 'tool')).toHaveLength(3)
	})
})

describe('a pinned tool result and the cheap in-place reclaim', () => {
	function bigResults(pin: boolean): Message[] {
		const calls = [0, 1, 2, 3].map((i) => ({
			id: `call_${i}`,
			type: 'function' as const,
			function: { name: 'lookup_account', arguments: '{}' },
		}))
		const msgs: Message[] = [createUserMessage('go')]
		for (const call of calls) {
			msgs.push(createAssistantMessage(null, [call]) as Message)
			const body = `${CONSTRAINT} ${'y'.repeat(5000)}`
			const result = createToolMessage(body, call.id) as Message
			msgs.push(pin && call.id === 'call_0' ? { ...result, retain: true } : result)
		}
		return msgs
	}

	it('is cleared without the marker', async () => {
		const edit = clearStaleToolResults(bigResults(false), { keepRecentToolResults: 1 })
		expect(edit.clearedCount).toBe(3)
	})

	it('keeps its content when marked', async () => {
		// Clearing keeps the message and replaces its content, which is
		// exactly the loss the marker was asked to prevent.
		const edit = clearStaleToolResults(bigResults(true), { keepRecentToolResults: 1 })

		expect(edit.clearedCount).toBe(2)
		expect(asText(edit.messages[2]?.content)).toContain(CONSTRAINT)
	})
})
