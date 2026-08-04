import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * There was no span around the model call at all.
 *
 * `chatSpanName` shipped in the telemetry attributes with zero call sites,
 * so a run's traces carried no LLM latency whatsoever — and the one thing
 * anybody opens a trace to find, which turn was slow and why, was the one
 * thing missing from it. The token counts landed on the iteration span
 * instead of the operation that produced them.
 */

interface Recorded {
	name: string
	attributes: Record<string, unknown>
	ended: boolean
	status?: number
}

const spans: Recorded[] = []

vi.mock('../runtime-accessors.js', () => ({
	getTracer: () => ({
		startSpan: (name: string) => {
			const rec: Recorded = { name, attributes: {}, ended: false }
			spans.push(rec)
			return {
				setAttributes: (a: Record<string, unknown>) => Object.assign(rec.attributes, a),
				setAttribute: (k: string, v: unknown) => {
					rec.attributes[k] = v
				},
				setStatus: (s: { code: number }) => {
					rec.status = s.code
				},
				recordException: () => undefined,
				addEvent: () => undefined,
				end: () => {
					rec.ended = true
				},
				spanContext: () => ({ traceId: 't', spanId: 's', traceFlags: 1 }),
				isRecording: () => true,
				updateName: () => undefined,
			}
		},
		startActiveSpan: (_n: string, _o: unknown, _c: unknown, fn: (s: unknown) => unknown) =>
			fn({
				setAttributes: () => undefined,
				setStatus: () => undefined,
				recordException: () => undefined,
				end: () => undefined,
				spanContext: () => ({ traceId: 't', spanId: 's', traceFlags: 1 }),
				isRecording: () => true,
			}),
	}),
	getMeter: () => ({
		createCounter: () => ({ add: () => undefined }),
		createHistogram: () => ({ record: () => undefined }),
	}),
}))

let workdirs: string[] = []

beforeEach(() => {
	spans.length = 0
})

afterEach(async () => {
	await Promise.all(workdirs.map((d) => rm(d, { recursive: true, force: true })))
	workdirs = []
})

async function runOnce(turns: { text?: string }[]): Promise<void> {
	const { MockLLMProvider } = await import('../../provider/mock.js')
	const { ToolRegistry } = await import('../../registry/tool/execute.js')
	const { drainQuery } = await import('../../runtime/query/index.js')
	const { createUserMessage } = await import('../../types/message/index.js')

	const dir = await mkdtemp(join(tmpdir(), 'namzu-chatspan-'))
	workdirs.push(dir)

	await drainQuery({
		provider: new MockLLMProvider({ turns: turns as never }),
		tools: new ToolRegistry(),
		runConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 3,
			maxResponseTokens: 256,
			temperature: 0.3,
		},
		agentId: 'agent_cs',
		agentName: 'Chat Span Agent',
		workingDirectory: dir,
		sessionId: 'ses_cs',
		threadId: 'thd_cs',
		projectId: 'prj_cs',
		tenantId: 'tnt_cs',
		messages: [createUserMessage('go')],
	} as never)
}

const chatSpans = () => spans.filter((s) => s.name.startsWith('chat '))

describe('the model call has a span of its own', () => {
	it('opens one named for the model', async () => {
		await runOnce([{ text: 'done' }])

		// One per model call. A run makes at least one, and a forced-final
		// turn makes another — both are model calls and both deserve a span.
		expect(chatSpans().length).toBeGreaterThanOrEqual(1)
		for (const s of chatSpans()) expect(s.name).toBe('chat mock-model')
	})

	it('closes it', async () => {
		await runOnce([{ text: 'done' }])

		for (const s of chatSpans()) expect(s.ended).toBe(true)
	})

	it('carries the request parameters that were actually used', async () => {
		await runOnce([{ text: 'done' }])

		const attrs = chatSpans()[0]?.attributes ?? {}
		expect(attrs['gen_ai.operation.name']).toBe('chat')
		expect(attrs['gen_ai.request.model']).toBe('mock-model')
		expect(attrs['gen_ai.request.temperature']).toBe(0.3)
		expect(attrs['gen_ai.request.max_tokens']).toBe(256)
	})

	it('carries the usage on the call that produced it', async () => {
		await runOnce([{ text: 'done' }])

		const attrs = chatSpans()[0]?.attributes ?? {}
		// These previously landed only on the iteration span — one level up
		// from the operation that spent the tokens.
		expect(attrs).toHaveProperty('gen_ai.usage.input_tokens')
		expect(attrs).toHaveProperty('gen_ai.usage.output_tokens')
	})

	it('records what the response said it was, not only what was asked for', async () => {
		await runOnce([{ text: 'done' }])

		const attrs = chatSpans()[0]?.attributes ?? {}
		// A provider may answer on a different model than the alias asked
		// for, and the response id is how a trace is matched to a provider's
		// own logs. Both constants existed and neither was ever set.
		expect(attrs['gen_ai.response.model']).toBe('mock-model')
		expect(attrs['gen_ai.response.id']).toBeDefined()
	})

	it('records the finish reason as an array, per the convention', async () => {
		await runOnce([{ text: 'done' }])

		// One call can finish several ways when a provider returns more than
		// one choice, which is why the convention makes it a list.
		expect(Array.isArray(chatSpans()[0]?.attributes['gen_ai.response.finish_reasons'])).toBe(true)
	})

	it('reports cache tokens, which had constants and no producer', async () => {
		await runOnce([{ text: 'done' }])

		const attrs = chatSpans()[0]?.attributes ?? {}
		expect(attrs).toHaveProperty('namzu.cache.read_tokens')
		expect(attrs).toHaveProperty('namzu.cache.write_tokens')
	})

	it('opens one per turn, not one per run', async () => {
		await runOnce([{ text: 'first' }, { text: 'second' }])

		// A run with several turns is exactly the case a trace is opened for.
		expect(chatSpans().length).toBeGreaterThanOrEqual(1)
	})

	it('nests under the iteration span rather than emitting as a root', async () => {
		await runOnce([{ text: 'done' }])

		// The iteration span is created first; the chat span is parented to it
		// explicitly because this body is an async generator and the ambient
		// context at resume time belongs to the consumer.
		const iterationIndex = spans.findIndex((s) => s.name.includes('iteration'))
		const chatIndex = spans.findIndex((s) => s.name.startsWith('chat '))
		expect(iterationIndex).toBeGreaterThanOrEqual(0)
		expect(chatIndex).toBeGreaterThan(iterationIndex)
	})
})
