import { describe, expect, it, vi } from 'vitest'

import type { AdvisorDefinition } from '../../types/advisory/index.js'
import type { Message } from '../../types/message/index.js'
import { AdvisoryContext } from '../context.js'
import { TriggerEvaluator } from '../evaluator.js'
import { AdvisoryExecutor } from '../executor.js'
import { ADVISORY_RESPONSE_CONTRACT } from '../parse.js'
import { AdvisorRegistry } from '../registry.js'

/**
 * An advisor consulted BY THE MODEL saw the question and nothing else.
 *
 * Two paths reach `AdvisoryExecutor.consult`. The trigger path
 * (`iteration/phases/advisory.ts`) has always passed the live messages, the
 * working state and the tool catalogue. The tool path passed
 * `{ messages: [], iteration: 0 }` — a literal empty context — so the
 * model's own `include_context: true` had nothing to include, and the
 * advisor answered a question about a situation it could not see.
 */

function recordingProvider(): { provider: AdvisorDefinition['provider']; calls: Message[][] } {
	const calls: Message[][] = []
	const provider = {
		chatStream: async function* (params: { messages: Message[] }) {
			calls.push(params.messages)
			yield { id: 'a1', delta: { content: 'ADVICE: do the thing' } }
			yield {
				id: 'a1',
				delta: {},
				finishReason: 'stop',
				usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
			}
		},
	} as unknown as AdvisorDefinition['provider']
	return { provider, calls }
}

function advisor(over: Partial<AdvisorDefinition> = {}): AdvisorDefinition {
	return {
		id: 'adv_1',
		name: 'Reviewer',
		provider: recordingProvider().provider,
		model: 'mock-model',
		...over,
	} as AdvisorDefinition
}

const log = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	child: () => log,
} as never

function contextFor(a: AdvisorDefinition): AdvisoryContext {
	return new AdvisoryContext(
		new AdvisorRegistry([a]),
		new AdvisoryExecutor(log),
		new TriggerEvaluator([]),
	)
}

describe('the context a tool-initiated consultation is given', () => {
	it('is empty until the runtime supplies one', () => {
		const ctx = contextFor(advisor())

		// The fallback exists for a context built without a runtime, and it is
		// what every tool-initiated call used to get.
		expect(ctx.callContext()).toEqual({ messages: [], iteration: 0 })
	})

	it('is the live run once the runtime wires it', () => {
		const ctx = contextFor(advisor())
		const messages: Message[] = [{ role: 'user', content: 'the situation', timestamp: 1 }]

		ctx.setCallContextProvider(() => ({ messages, iteration: 7 }))

		expect(ctx.callContext().messages).toBe(messages)
		expect(ctx.callContext().iteration).toBe(7)
	})

	it('is read at call time, not at construction', () => {
		const ctx = contextFor(advisor())
		let iteration = 1
		ctx.setCallContextProvider(() => ({ messages: [], iteration }))

		iteration = 4

		// The tool is built once per run and called at an unknown later point.
		// A snapshot would hand every advisor the state the run started with.
		expect(ctx.callContext().iteration).toBe(4)
	})
})

describe('what the advisor actually receives', () => {
	it('sees the conversation when context is included', async () => {
		const { provider, calls } = recordingProvider()
		const executor = new AdvisoryExecutor(log)

		await executor.consult(
			advisor({ provider }),
			{ advisorId: 'adv_1', question: 'what next?', includeContext: true },
			{ messages: [{ role: 'user', content: 'deploy is failing', timestamp: 1 }], iteration: 2 },
		)

		const sent = JSON.stringify(calls[0])
		expect(sent).toContain('deploy is failing')
	})

	it('sees none of it when the caller says not to', async () => {
		const { provider, calls } = recordingProvider()
		const executor = new AdvisoryExecutor(log)

		await executor.consult(
			advisor({ provider }),
			{ advisorId: 'adv_1', question: 'what next?', includeContext: false },
			{ messages: [{ role: 'user', content: 'deploy is failing', timestamp: 1 }], iteration: 2 },
		)

		expect(JSON.stringify(calls[0])).not.toContain('deploy is failing')
	})

	it('is told when the caller marked the request urgent', async () => {
		const { provider, calls } = recordingProvider()
		const executor = new AdvisoryExecutor(log)

		await executor.consult(
			advisor({ provider }),
			{ advisorId: 'adv_1', question: 'what next?', urgency: 'high' },
			{ messages: [], iteration: 1 },
		)

		// The value used to reach exactly one debug log line, so 'high' and
		// 'low' produced byte-identical requests.
		expect(String(calls[0]?.[0]?.content)).toContain('URGENT')
	})

	it('is told when there is room to consider alternatives', async () => {
		const { provider, calls } = recordingProvider()
		const executor = new AdvisoryExecutor(log)

		await executor.consult(
			advisor({ provider }),
			{ advisorId: 'adv_1', question: 'what next?', urgency: 'low' },
			{ messages: [], iteration: 1 },
		)

		expect(String(calls[0]?.[0]?.content)).toContain('low urgency')
	})

	it("appends nothing at all for 'normal', which is the point of not stating it", async () => {
		const { provider, calls } = recordingProvider()
		const executor = new AdvisoryExecutor(log)
		const a = advisor({ provider })

		await executor.consult(
			a,
			{ advisorId: 'adv_1', question: 'what next?', urgency: 'normal' },
			{ messages: [], iteration: 1 },
		)
		await executor.consult(
			a,
			{ advisorId: 'adv_1', question: 'what next?', urgency: 'high' },
			{ messages: [], iteration: 1 },
		)

		// Asserting "does not contain the other two phrases" is too weak — it
		// would let ANY new sentence in. The response contract is the last
		// thing the prompt says when urgency contributes nothing, so ending on
		// it is what "appended nothing" actually means.
		expect(String(calls[0]?.[0]?.content).trimEnd().endsWith(ADVISORY_RESPONSE_CONTRACT)).toBe(true)
		expect(String(calls[1]?.[0]?.content).trimEnd().endsWith(ADVISORY_RESPONSE_CONTRACT)).toBe(
			false,
		)
	})

	it('says nothing about urgency when the caller did not', async () => {
		const { provider, calls } = recordingProvider()
		const executor = new AdvisoryExecutor(log)

		await executor.consult(
			advisor({ provider }),
			{ advisorId: 'adv_1', question: 'what next?' },
			{ messages: [], iteration: 1 },
		)

		expect(String(calls[0]?.[0]?.content).trimEnd().endsWith(ADVISORY_RESPONSE_CONTRACT)).toBe(true)
	})
})
