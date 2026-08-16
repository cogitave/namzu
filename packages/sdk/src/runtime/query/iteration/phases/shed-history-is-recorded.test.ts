import { describe, expect, it, vi } from 'vitest'

import { WorkingStateManager } from '../../../../compaction/manager.js'
import type { ContextReducer } from '../../../../compaction/reducer.js'
import { CompactionConfigSchema } from '../../../../config/runtime.js'
import type { CompactionConfig } from '../../../../config/runtime.js'
import type { Message } from '../../../../types/message/index.js'
import { isEphemeralEvent } from '../../../../types/run/events.js'
import type { RunEvent } from '../../../../types/run/index.js'
import { runCompactionCheck } from './compaction.js'
import type { IterationContext } from './context.js'

/**
 * A compaction deleted its own evidence.
 *
 * `compaction_completed` carries counts and nothing else, both shed sites
 * REPLACE the live message array, and `persist()` writes `messages.json`
 * wholesale afterwards. So what a pass removed existed nowhere: not in
 * memory, not on disk, not in the transcript. "What did the agent decide
 * three compactions ago" was unanswerable, an undo had no input, and a
 * search index over run history could never see the part that mattered
 * most.
 *
 * The ordering is the property, not the presence. `transcript.jsonl` is
 * append-only and `emitEvent` reaches it synchronously with the pass, so a
 * record emitted BEFORE the install is durable before the deletion is —
 * emitted after, a crash between the two loses exactly what this keeps.
 */

const sys = (content: string): Message => ({ role: 'system', content, timestamp: 1 })
const user = (content: string): Message => ({ role: 'user', content, timestamp: 1 })

function longHistory(): Message[] {
	return [sys('prompt'), ...Array.from({ length: 40 }, (_, i) => user(`turn ${i} `.repeat(200)))]
}

interface Harness {
	readonly ctx: IterationContext
	readonly messages: Message[]
	readonly events: RunEvent[]
	/** The live array as it stood when each event was emitted. */
	readonly lengthsAtEmit: number[]
}

function harness(over: { compaction?: Partial<CompactionConfig>; reducer?: ContextReducer } = {}) {
	const messages = longHistory()
	const config: CompactionConfig = {
		...CompactionConfigSchema.parse({}),
		contextWindowTokens: 1_000,
		keepRecentMessages: 4,
		llmVerification: false,
		...over.compaction,
	}
	const events: RunEvent[] = []
	const lengthsAtEmit: number[] = []

	const ctx = {
		compactionConfig: config,
		workingStateManager: new WorkingStateManager(config),
		runConfig: { model: 'mock-model' },
		...(over.reducer ? { contextReducer: over.reducer } : {}),
		runMgr: {
			id: 'run_shed',
			currentIteration: 3,
			messages,
			accumulateUsage: vi.fn(),
			clearLastPromptTokens: vi.fn(),
		},
		emitEvent: async (event: RunEvent) => {
			events.push(event)
			// Recorded at emit time. This is what turns "the event exists"
			// into "the event exists BEFORE the deletion", which is the only
			// version of the property that survives a crash.
			lengthsAtEmit.push(messages.length)
		},
		provider: {
			chat: async () => ({ content: 'summary', usage: { promptTokens: 1, completionTokens: 1 } }),
		},
		log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as IterationContext

	return { ctx, messages, events, lengthsAtEmit } satisfies Harness
}

const shedOf = (h: Harness) =>
	h.events.filter(
		(e): e is Extract<RunEvent, { type: 'compaction_shed' }> => e.type === 'compaction_shed',
	)

describe('a compaction records what it removes', () => {
	it('emits exactly what left the history, on the structured path', async () => {
		const h = harness({ compaction: { strategy: 'structured' } })
		const before = [...h.messages]

		await runCompactionCheck(h.ctx)

		const shed = shedOf(h)
		expect(shed).toHaveLength(1)
		// The exact set: present before, absent after. Not "everything up to
		// the cut" — the pass can re-pin messages from the middle, and those
		// are still there.
		const after = new Set(h.messages)
		expect(shed[0]?.messages).toEqual(before.filter((m) => !after.has(m)))
		expect(shed[0]?.messages.length).toBeGreaterThan(0)
	})

	it('emits it BEFORE the array is replaced', async () => {
		const h = harness({ compaction: { strategy: 'structured' } })
		const originalLength = h.messages.length

		await runCompactionCheck(h.ctx)

		const index = h.events.findIndex((e) => e.type === 'compaction_shed')
		expect(index).toBeGreaterThanOrEqual(0)
		// The live array was still whole when the record was written.
		expect(h.lengthsAtEmit[index]).toBe(originalLength)
	})

	it('comes before the compaction_completed it pairs with', async () => {
		const h = harness({ compaction: { strategy: 'structured' } })

		await runCompactionCheck(h.ctx)

		const shed = h.events.findIndex((e) => e.type === 'compaction_shed')
		const completed = h.events.findIndex((e) => e.type === 'compaction_completed')
		expect(shed).toBeGreaterThanOrEqual(0)
		expect(completed).toBeGreaterThan(shed)
	})

	it('records the reducer path too', async () => {
		// One-site-is-not-every-site. A host-supplied reducer owns reduction
		// entirely and installs the array on its own line; wiring only the
		// structured site leaves every sliding-window run recording nothing.
		const reducer: ContextReducer = ({ messages }) => messages.slice(10)
		const h = harness({ reducer })
		const before = [...h.messages]

		await runCompactionCheck(h.ctx)

		const shed = shedOf(h)
		expect(shed).toHaveLength(1)
		const after = new Set(h.messages)
		expect(shed[0]?.messages).toEqual(before.filter((m) => !after.has(m)))
	})

	it('records nothing when the flag is off, and changes nothing else', async () => {
		// A flag nothing reads is the defect this repo has a rule about.
		const on = harness({ compaction: { strategy: 'structured' } })
		const off = harness({ compaction: { strategy: 'structured', recordShedHistory: false } })

		await runCompactionCheck(on.ctx)
		await runCompactionCheck(off.ctx)

		expect(shedOf(off)).toHaveLength(0)
		expect(off.events.map((e) => e.type)).toEqual(
			on.events.map((e) => e.type).filter((t) => t !== 'compaction_shed'),
		)
		expect(off.messages.length).toBe(on.messages.length)
	})

	it('records nothing when a pass sheds nothing', async () => {
		// A history under the threshold. An empty record is indistinguishable
		// from a real record of nothing, so there is none.
		const h = harness({ compaction: { strategy: 'structured', contextWindowTokens: 10_000_000 } })

		await runCompactionCheck(h.ctx)

		expect(shedOf(h)).toHaveLength(0)
	})

	it('is durable, not ephemeral', async () => {
		// The whole point is the transcript. In `EPHEMERAL_EVENT_TYPES` this
		// would reach a live subscriber and nothing else — leaving the record
		// exactly as absent as before, with every test above still green.
		expect(
			isEphemeralEvent({
				type: 'compaction_shed',
				runId: 'run_x',
				iteration: 1,
				messages: [],
				reason: 'threshold',
			} as never),
		).toBe(false)
	})
})
