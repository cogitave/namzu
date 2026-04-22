/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 6):
 *
 *   - `AdvisoryExecutor.consult(advisor, request, callCtx)`:
 *     - Builds a system prompt (see buildSystemPrompt tests).
 *     - Builds a context message block (see buildContext tests).
 *     - Concatenates `[system, ...context, user(question)]` and calls
 *       `advisor.provider.chat(...)` with `toolChoice: 'none'`.
 *     - Parses the response via a passthrough `{ advice: rawContent }`
 *       shape (no structured parsing yet — advisor.ts line 166-168).
 *     - Returns `{result, usage, cost, durationMs}`. `cost` is a
 *       zero-value `CostInfo` — pricing is provider-specific and not
 *       applied here.
 *
 *   - `buildSystemPrompt` priority:
 *     1. `advisor.systemPrompt` (verbatim).
 *     2. `advisor.persona` (via `assembleSystemPrompt`).
 *     3. Fallback: "You are <name>, an advisory agent." + optional
 *        domains line + "Provide concise, actionable advice..."
 *
 *   - `buildContext`:
 *     - Returns [] when `request.includeContext === false`.
 *     - Includes workingStateSummary when present.
 *     - Includes toolCatalog names when present + non-empty.
 *     - Includes truncated conversation context (most-recent-first
 *       walk, bounded by `advisor.maxContextTokens * CHARS_PER_TOKEN`).
 *     - Returns [] when no context parts were assembled.
 *
 *   - `truncateMessages(msgs, maxTokens)` walks right-to-left and
 *     includes messages until the char budget is exhausted (in token
 *     terms). Returns the included subset preserving original order.
 *     No limit when `maxTokens` is undefined.
 */

import { describe, expect, it, vi } from 'vitest'

import type { AdvisorDefinition } from '../types/advisory/config.js'
import type { AdvisoryRequest } from '../types/advisory/result.js'
import type { Message } from '../types/message/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
} from '../types/provider/index.js'

import { type AdvisoryCallContext, AdvisoryExecutor } from './executor.js'

function mockProvider(response: Partial<ChatCompletionResponse> = {}): LLMProvider {
	const chat = vi.fn<(p: ChatCompletionParams) => Promise<ChatCompletionResponse>>(async () => ({
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
	}))
	return {
		id: 'mock',
		name: 'Mock',
		chat,
		chatStream: vi.fn(),
	} as unknown as LLMProvider
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
		const call = vi.mocked(provider.chat).mock.calls[0]?.[0] as ChatCompletionParams
		expect(call.model).toBe('m')
		expect(call.toolChoice).toBe('none')
		const roles = call.messages.map((m) => m.role)
		expect(roles[0]).toBe('system')
		expect(roles.at(-1)).toBe('user')
	})

	it('returns {result, usage, cost, durationMs}; cost is zero-valued', async () => {
		const e = new AdvisoryExecutor()
		const out = await e.consult(advisor(), req, ctx())
		expect(out.result.advice).toBe('advice text')
		expect(out.usage.totalTokens).toBe(150)
		expect(out.cost).toEqual({
			inputCostPer1M: 0,
			outputCostPer1M: 0,
			totalCost: 0,
			cacheDiscount: 0,
		})
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
	it('uses advisor.systemPrompt verbatim when set', async () => {
		const provider = mockProvider()
		const e = new AdvisoryExecutor()
		await e.consult(advisor({ provider, systemPrompt: 'FIXED PROMPT' }), req, ctx())
		const call = vi.mocked(provider.chat).mock.calls[0]?.[0] as ChatCompletionParams
		expect(call.messages[0]?.content).toBe('FIXED PROMPT')
	})

	it('falls back to name + domains + boilerplate when no systemPrompt or persona', async () => {
		const provider = mockProvider()
		const e = new AdvisoryExecutor()
		await e.consult(
			advisor({ provider, name: 'Architect', domains: ['security', 'performance'] }),
			req,
			ctx(),
		)
		const call = vi.mocked(provider.chat).mock.calls[0]?.[0] as ChatCompletionParams
		const systemContent = call.messages[0]?.content ?? ''
		expect(systemContent).toContain('Architect')
		expect(systemContent).toContain('security, performance')
		expect(systemContent).toContain('concise, actionable advice')
	})

	it('fallback without domains omits the domains line', async () => {
		const provider = mockProvider()
		const e = new AdvisoryExecutor()
		await e.consult(advisor({ provider, name: 'Adv' }), req, ctx())
		const call = vi.mocked(provider.chat).mock.calls[0]?.[0] as ChatCompletionParams
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
		const call = vi.mocked(provider.chat).mock.calls[0]?.[0] as ChatCompletionParams
		// Only system + user(question)
		expect(call.messages).toHaveLength(2)
	})

	it('includes workingStateSummary + toolCatalog names when present', async () => {
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
		const call = vi.mocked(provider.chat).mock.calls[0]?.[0] as ChatCompletionParams
		const contextMsg = call.messages[1]?.content ?? ''
		expect(contextMsg).toContain('Working State')
		expect(contextMsg).toContain('state summary here')
		expect(contextMsg).toContain('Available Tools')
		expect(contextMsg).toContain('read_file, write_file')
	})

	it('includes conversation context (no truncation when no maxContextTokens)', async () => {
		const provider = mockProvider()
		const messages: Message[] = [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'hello' },
		]
		const e = new AdvisoryExecutor()
		await e.consult(advisor({ provider }), req, ctx({ messages }))
		const call = vi.mocked(provider.chat).mock.calls[0]?.[0] as ChatCompletionParams
		const contextMsg = call.messages[1]?.content ?? ''
		expect(contextMsg).toContain('Conversation Context')
		expect(contextMsg).toContain('[user]: hi')
		expect(contextMsg).toContain('[assistant]: hello')
	})

	it('truncates conversation from the back when maxContextTokens is set', async () => {
		const provider = mockProvider()
		const messages: Message[] = [
			{ role: 'user', content: 'a'.repeat(100) }, // oldest — should be dropped
			{ role: 'user', content: 'recent' },
		]
		const e = new AdvisoryExecutor()
		// maxContextTokens=5 → 5*4=20 char budget; only 'recent' (6 chars) fits.
		await e.consult(advisor({ provider, maxContextTokens: 5 }), req, ctx({ messages }))
		const call = vi.mocked(provider.chat).mock.calls[0]?.[0] as ChatCompletionParams
		const contextMsg = call.messages[1]?.content ?? ''
		expect(contextMsg).toContain('recent')
		expect(contextMsg).not.toContain('a'.repeat(100))
	})

	it('omits the context message entirely when there are no context parts', async () => {
		const provider = mockProvider()
		const e = new AdvisoryExecutor()
		await e.consult(advisor({ provider }), req, ctx())
		const call = vi.mocked(provider.chat).mock.calls[0]?.[0] as ChatCompletionParams
		expect(call.messages).toHaveLength(2)
	})
})

describe('AdvisoryExecutor — tool calls in context', () => {
	it('represents assistant messages with tool calls as "(tool calls)" stub', async () => {
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
		const call = vi.mocked(provider.chat).mock.calls[0]?.[0] as ChatCompletionParams
		const contextMsg = call.messages[1]?.content ?? ''
		expect(contextMsg).toContain('[assistant]: (tool calls)')
	})
})
