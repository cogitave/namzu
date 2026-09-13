// Exercise the actual tool-free provider request, not only string helpers.

import { describe, expect, it, vi } from 'vitest'

import type { AdvisorDefinition } from '../types/advisory/config.js'
import type { AdvisoryRequest } from '../types/advisory/result.js'
import type { Message } from '../types/message/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
	StreamChunk,
} from '../types/provider/index.js'

import { type AdvisoryCallContext, AdvisoryExecutor } from './executor.js'
import { ADVISORY_RESPONSE_CONTRACT } from './parse.js'

/**
 * Builds a minimal mock provider for advisory tests. Phase 2 of
 * ses_001-tool-stream-events removed `chat()` from `LLMProvider`, so
 * the test stubs `chatStream` and `AdvisoryExecutor` consumes via
 * `collectChatCompletion()`. The mock returns a single chunk with the legacy text +
 * usage so the aggregated response shape matches what `chat()` would
 * have returned.
 */
function mockProvider(response: Partial<ChatCompletionResponse> = {}): LLMProvider {
	const merged: ChatCompletionResponse = {
		id: 'resp_1',
		model: 'm',
		message: { role: 'assistant', content: 'advice text' },
		usage: {
			promptTokens: 100,
			completionTokens: 50,
			totalTokens: 150,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		finishReason: 'stop',
		...response,
	}
	const chatStream = vi.fn<(p: ChatCompletionParams) => AsyncIterable<StreamChunk>>(() => {
		const chunks: StreamChunk[] = [
			{ id: merged.id, delta: { content: merged.message.content ?? '' } },
			{
				id: merged.id,
				delta: {},
				finishReason: merged.finishReason,
				usage: merged.usage,
			},
		]
		return (async function* () {
			for (const c of chunks) yield c
		})()
	})
	return {
		id: 'mock',
		name: 'Mock',
		chatStream,
	}
}

function advisor(overrides: Partial<AdvisorDefinition> = {}): AdvisorDefinition {
	return {
		id: 'adv',
		name: 'Adv',
		provider: mockProvider(),
		model: 'm',
		...overrides,
	}
}

function ctx(overrides: Partial<AdvisoryCallContext> = {}): AdvisoryCallContext {
	return {
		messages: [],
		iteration: 1,
		...overrides,
	}
}

const req: AdvisoryRequest = { question: 'what next?' }

describe('AdvisoryExecutor — consult happy path', () => {
	it('calls provider.chat with system + question, toolChoice none', async () => {
		const provider = mockProvider()
		const e = new AdvisoryExecutor()
		const a = advisor({ provider, systemPrompt: 'You are Adv.' })
		await e.consult(a, req, ctx())
		const call = vi.mocked(provider.chatStream).mock.calls[0]?.[0] as ChatCompletionParams
		expect(call.model).toBe('m')
		expect(call.toolChoice).toBe('none')
		const roles = call.messages.map((m) => m.role)
		expect(roles[0]).toBe('system')
		expect(roles.at(-1)).toBe('user')
	})

	it('returns {result, usage, cost, durationMs}; an unpriced advisor reports unknown', async () => {
		// This used to assert `{ inputCostPer1M: 0, ..., totalCost: 0 }` — a
		// rate card of zero and a bill of zero for a call that consumed 150
		// tokens of somebody's money. It was defended on the grounds that a
		// cost CAP over unpriced advisors is refused at construction, so
		// nothing enforced against the zero. True, and beside the point:
		// `AdvisoryResult.cost` is reported to the host, and `$0.00` for real
		// spend is the defect the price catalogue exists to remove. It does not
		// become acceptable because the number happens to be unenforced.
		const e = new AdvisoryExecutor()
		const out = await e.consult(advisor(), req, ctx())
		expect(out.result.advice).toBe('advice text')
		expect(out.usage.totalTokens).toBe(150)
		expect(out.cost).toEqual({
			totalCost: 0,
			cacheDiscount: 0,
			unpricedTokens: 150,
		})
		// No rate card is claimed, because none was applied.
		expect(out.cost.inputCostPer1M).toBeUndefined()
		expect(typeof out.durationMs).toBe('number')
	})

	it('parseResult is currently a passthrough — advice = content verbatim', async () => {
		const provider = mockProvider({
			message: { role: 'assistant', content: 'Raw text with **markdown**' },
		})
		const e = new AdvisoryExecutor()
		const out = await e.consult(advisor({ provider }), req, ctx())
		expect(out.result.advice).toBe('Raw text with **markdown**')
	})

	it('handles null provider content as empty string', async () => {
		const provider = mockProvider({
			message: { role: 'assistant', content: null },
		})
		const e = new AdvisoryExecutor()
		const out = await e.consult(advisor({ provider }), req, ctx())
		expect(out.result.advice).toBe('')
	})
})

describe('AdvisoryExecutor — buildSystemPrompt', () => {
	it('keeps advisor.systemPrompt and appends the response contract', async () => {
		const provider = mockProvider()
		const e = new AdvisoryExecutor()
		await e.consult(advisor({ provider, systemPrompt: 'FIXED PROMPT' }), req, ctx())
		const call = vi.mocked(provider.chatStream).mock.calls[0]?.[0] as ChatCompletionParams
		expect(call.messages[0]?.content).toContain('FIXED PROMPT')
		expect(call.messages[0]?.content).toContain(ADVISORY_RESPONSE_CONTRACT)
	})

	it('falls back to name + domains + boilerplate when no systemPrompt or persona', async () => {
		const provider = mockProvider()
		const e = new AdvisoryExecutor()
		await e.consult(
			advisor({ provider, name: 'Architect', domains: ['security', 'performance'] }),
			req,
			ctx(),
		)
		const call = vi.mocked(provider.chatStream).mock.calls[0]?.[0] as ChatCompletionParams
		const systemContent = call.messages[0]?.content ?? ''
		expect(systemContent).toContain('Architect')
		expect(systemContent).toContain('security, performance')
		expect(systemContent).toContain('concise, actionable advice')
	})

	it('fallback without domains omits the domains line', async () => {
		const provider = mockProvider()
		const e = new AdvisoryExecutor()
		await e.consult(advisor({ provider, name: 'Adv' }), req, ctx())
		const call = vi.mocked(provider.chatStream).mock.calls[0]?.[0] as ChatCompletionParams
		const systemContent = call.messages[0]?.content ?? ''
		expect(systemContent).not.toContain('domains of expertise')
	})
})

describe('AdvisoryExecutor — buildContext', () => {
	it('returns no context message when request.includeContext is false', async () => {
		const provider = mockProvider()
		const e = new AdvisoryExecutor()
		await e.consult(
			advisor({ provider }),
			{ question: 'q', includeContext: false },
			ctx({ workingStateSummary: 'should be ignored' }),
		)
		const call = vi.mocked(provider.chatStream).mock.calls[0]?.[0] as ChatCompletionParams
		// Only system + user(question)
		expect(call.messages).toHaveLength(2)
	})

	it('includes workingStateSummary + runtime tool summary when present', async () => {
		const provider = mockProvider()
		const e = new AdvisoryExecutor()
		await e.consult(advisor({ provider }), req, {
			messages: [],
			iteration: 1,
			workingStateSummary: 'state summary here',
			toolCatalog: [
				{
					type: 'function',
					function: { name: 'read_file', description: 'read', parameters: {} },
				},
				{
					type: 'function',
					function: { name: 'write_file', description: 'write', parameters: {} },
				},
			],
		})
		const call = vi.mocked(provider.chatStream).mock.calls[0]?.[0] as ChatCompletionParams
		const contextMsg = call.messages[1]?.content ?? ''
		expect(contextMsg).toContain('Working State')
		expect(contextMsg).toContain('state summary here')
		expect(contextMsg).toContain('Runtime Tool Summary')
		expect(contextMsg).toContain('executable schemas remain owned by the runtime tool catalogue')
		expect(contextMsg).toContain('- read_file: read')
		expect(contextMsg).toContain('- write_file: write')
	})

	it('includes conversation context (no truncation when no maxContextTokens)', async () => {
		const provider = mockProvider()
		const messages: Message[] = [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'hello' },
		]
		const e = new AdvisoryExecutor()
		await e.consult(advisor({ provider }), req, ctx({ messages }))
		const call = vi.mocked(provider.chatStream).mock.calls[0]?.[0] as ChatCompletionParams
		const contextMsg = call.messages[1]?.content ?? ''
		expect(contextMsg).toContain('Conversation Context')
		expect(contextMsg).toContain(JSON.stringify({ role: 'user', content: 'hi' }))
		expect(contextMsg).toContain(JSON.stringify({ role: 'assistant', content: 'hello' }))
	})

	it('truncates conversation from the back when maxContextTokens is set', async () => {
		const provider = mockProvider()
		const messages: Message[] = [
			{ role: 'user', content: 'a'.repeat(100) }, // oldest — should be dropped
			{ role: 'user', content: 'recent' },
		]
		const e = new AdvisoryExecutor()
		// 20*4=80 serialized characters: only the recent whole record fits.
		await e.consult(advisor({ provider, maxContextTokens: 20 }), req, ctx({ messages }))
		const call = vi.mocked(provider.chatStream).mock.calls[0]?.[0] as ChatCompletionParams
		const contextMsg = call.messages[1]?.content ?? ''
		expect(contextMsg).toContain('recent')
		expect(contextMsg).not.toContain('a'.repeat(100))
	})

	it('omits the context message entirely when there are no context parts', async () => {
		const provider = mockProvider()
		const e = new AdvisoryExecutor()
		await e.consult(advisor({ provider }), req, ctx())
		const call = vi.mocked(provider.chatStream).mock.calls[0]?.[0] as ChatCompletionParams
		expect(call.messages).toHaveLength(2)
	})
})

describe('AdvisoryExecutor — tool calls in context', () => {
	it('preserves the tool call ID, name and arguments in the provider request', async () => {
		const provider = mockProvider()
		const e = new AdvisoryExecutor()
		await e.consult(
			advisor({ provider }),
			req,
			ctx({
				messages: [
					{
						role: 'assistant',
						content: null,
						toolCalls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }],
					},
				],
			}),
		)
		const call = vi.mocked(provider.chatStream).mock.calls[0]?.[0] as ChatCompletionParams
		const contextMsg = call.messages[1]?.content ?? ''
		expect(contextMsg).toContain(JSON.stringify({ id: 't1', name: 'x', arguments: '{}' }))
	})
})
