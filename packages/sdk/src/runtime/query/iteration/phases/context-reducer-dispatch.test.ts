import { describe, expect, it, vi } from 'vitest'

import { WorkingStateManager } from '../../../../compaction/manager.js'
import type { ContextReducer } from '../../../../compaction/reducer.js'
import { CompactionConfigSchema } from '../../../../config/runtime.js'
import type { CompactionConfig } from '../../../../config/runtime.js'
import type { Message } from '../../../../types/message/index.js'
import { runCompactionCheck } from './compaction.js'
import type { IterationContext } from './context.js'

/**
 * `strategy` had three values and two behaviours.
 *
 * The runtime asked only `strategy !== 'disabled'`, so `'sliding-window'` —
 * the name a host picks precisely to AVOID paying for summarization — ran the
 * full structured pass, model call included. These tests are about the
 * dispatch rather than the algorithms: that choosing a strategy selects one,
 * that a host-supplied reducer outranks the enum, and that the structured
 * pass does not also run when something else owns reduction.
 */

const sys = (content: string): Message => ({ role: 'system', content, timestamp: 1 })
const user = (content: string): Message => ({ role: 'user', content, timestamp: 1 })

function longHistory(): Message[] {
	// Long enough to be over any threshold once the window is small.
	return [sys('prompt'), ...Array.from({ length: 40 }, (_, i) => user(`turn ${i} `.repeat(200)))]
}

interface Harness {
	readonly ctx: IterationContext
	readonly messages: Message[]
	readonly providerCalls: () => number
	readonly warnings: string[]
}

function harness(
	over: Partial<IterationContext> & { compaction?: Partial<CompactionConfig> },
): Harness {
	const messages = longHistory()
	const config: CompactionConfig = {
		...CompactionConfigSchema.parse({}),
		// A tiny window puts the run over the trigger immediately.
		contextWindowTokens: 1_000,
		keepRecentMessages: 4,
		...over.compaction,
	}
	const warnings: string[] = []
	let providerCalls = 0

	const ctx = {
		compactionConfig: config,
		workingStateManager: new WorkingStateManager(config),
		runConfig: { model: 'mock-model' },
		runMgr: {
			id: 'run_dispatch',
			messages,
			accumulateUsage: vi.fn(),
			clearLastPromptTokens: vi.fn(),
		},
		provider: {
			// The structured path's only observable side effect that a reducer
			// path must not have: it pays for a summary.
			chat: async () => {
				providerCalls++
				return { content: 'summary', usage: { promptTokens: 1, completionTokens: 1 } }
			},
		},
		log: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: (message: string) => warnings.push(message),
			error: vi.fn(),
		},
		...over,
	} as unknown as IterationContext

	return { ctx, messages, providerCalls: () => providerCalls, warnings }
}

describe('choosing a strategy selects one', () => {
	it("'sliding-window' trims and summarizes nothing", async () => {
		const h = harness({ compaction: { strategy: 'sliding-window', llmVerification: true } })

		await runCompactionCheck(h.ctx)

		expect(h.messages.length).toBeLessThan(41)
		// The whole reason a host names this strategy.
		expect(h.providerCalls()).toBe(0)
		// Every survivor is verbatim — no `[COMPACTED CONTEXT]` block appears.
		expect(h.messages.some((m) => String(m.content).includes('COMPACTED CONTEXT'))).toBe(false)
	})

	it("'structured' still summarizes", async () => {
		const h = harness({ compaction: { strategy: 'structured', llmVerification: false } })

		await runCompactionCheck(h.ctx)

		expect(h.messages.some((m) => String(m.content).includes('COMPACTED CONTEXT'))).toBe(true)
	})

	it("'disabled' leaves the history alone", async () => {
		const h = harness({ compaction: { strategy: 'disabled' } })

		await runCompactionCheck(h.ctx)

		expect(h.messages.length).toBe(41)
	})
})

describe('a host reducer outranks the enum', () => {
	it('runs instead of the structured pass', async () => {
		// Deliberately NOT a tiny slice: leave more than the structured pass
		// needs to act, so "the reducer ran" and "only the reducer ran" are
		// different observations.
		const reduce: ContextReducer = ({ messages }) => messages.slice(0, 20)
		const h = harness({ contextReducer: reduce, compaction: { strategy: 'structured' } })

		await runCompactionCheck(h.ctx)

		expect(h.messages.length).toBe(20)
		expect(h.messages.some((m) => String(m.content).includes('COMPACTED CONTEXT'))).toBe(false)
	})

	it('is told whether the provider already rejected the prompt', async () => {
		const seen: string[] = []
		const reduce: ContextReducer = ({ messages, reason }) => {
			seen.push(reason)
			return messages.slice(0, 5)
		}
		const h = harness({ contextReducer: reduce })

		await runCompactionCheck(h.ctx)
		await runCompactionCheck(h.ctx, { force: true })

		expect(seen).toEqual(['threshold', 'overflow'])
	})

	it('may be async, so a reducer can call a model of its own', async () => {
		const reduce: ContextReducer = async ({ messages }) => {
			await Promise.resolve()
			return messages.slice(0, 3)
		}
		const h = harness({ contextReducer: reduce })

		await runCompactionCheck(h.ctx)

		expect(h.messages.length).toBe(3)
	})

	it('gets the window it has to fit, not the run token budget', async () => {
		let saw = 0
		const reduce: ContextReducer = ({ contextWindowTokens, messages }) => {
			saw = contextWindowTokens
			return messages.slice(0, 5)
		}
		const h = harness({ contextReducer: reduce, compaction: { contextWindowTokens: 12_345 } })

		await runCompactionCheck(h.ctx)

		expect(saw).toBe(12_345)
	})
})

describe('a reducer that cannot be trusted is not obeyed', () => {
	it('keeps the full history when the reducer throws', async () => {
		const reduce: ContextReducer = () => {
			throw new Error('boom')
		}
		const h = harness({ contextReducer: reduce })

		await runCompactionCheck(h.ctx)

		// Fail open: a broken reduction hook should not take down a healthy run,
		// the same way a broken `prepareStep` does not.
		expect(h.messages.length).toBe(41)
		expect(h.warnings.some((w) => w.includes('threw'))).toBe(true)
	})

	it('refuses a result that orphans a tool result', async () => {
		const h = harness({
			contextReducer: ({ messages }) => [
				messages[0] as Message,
				{ role: 'tool', content: 'ok', timestamp: 1, toolCallId: 'nobody' } as Message,
			],
		})

		await runCompactionCheck(h.ctx)

		// Installing this would trade a nameable "your reducer split a tool
		// pair" for an opaque provider rejection a call later.
		expect(h.messages.length).toBe(41)
		expect(h.warnings.some((w) => w.includes('split a tool pair'))).toBe(true)
	})

	it('ignores a reducer that returns the history unchanged', async () => {
		const h = harness({ contextReducer: ({ messages }) => messages })

		await runCompactionCheck(h.ctx)

		expect(h.messages.length).toBe(41)
	})

	it('leaves the history alone when the reducer declines', async () => {
		const h = harness({ contextReducer: () => undefined })

		await runCompactionCheck(h.ctx)

		expect(h.messages.length).toBe(41)
	})
})

describe('the threshold still governs a reducer', () => {
	it('does not run one below the trigger', async () => {
		const reduce = vi.fn(() => undefined)
		const h = harness({
			contextReducer: reduce,
			// A window far larger than the history.
			compaction: { contextWindowTokens: 10_000_000 },
		})

		await runCompactionCheck(h.ctx)

		expect(reduce).not.toHaveBeenCalled()
	})

	it('runs one below the trigger when the provider forced the issue', async () => {
		const reduce = vi.fn(() => undefined)
		const h = harness({
			contextReducer: reduce,
			compaction: { contextWindowTokens: 10_000_000 },
		})

		await runCompactionCheck(h.ctx, { force: true })

		expect(reduce).toHaveBeenCalledOnce()
	})
})
