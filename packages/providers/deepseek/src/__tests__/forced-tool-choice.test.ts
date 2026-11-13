import { type ChatCompletionParams, ProviderRequestError } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DeepSeekProvider } from '../client.js'

/**
 * The vendor rejects `required` and a named function while thinking is on
 * (HTTP 400, "Thinking mode does not support this tool_choice"). Thinking is on
 * unless disabled, so the common case is the refused one.
 */

afterEach(() => {
	vi.unstubAllGlobals()
})

const FORCED = [
	['required', 'required'],
	['a named function', { type: 'function', function: { name: 'echo' } }],
] as const

function params(over: Partial<ChatCompletionParams> = {}): ChatCompletionParams {
	return {
		model: 'deepseek-v4-flash',
		messages: [{ role: 'user', content: 'x' }],
		...over,
	} as ChatCompletionParams
}

function stubFetch(): { bodies: Record<string, any>[] } {
	const bodies: Record<string, any>[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_input: unknown, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)))
			return new Response(JSON.stringify({ error: { message: 'fixture refusal' } }), {
				status: 400,
				headers: { 'content-type': 'application/json' },
			})
		}),
	)
	return { bodies }
}

async function run(over: Partial<ChatCompletionParams>): Promise<unknown> {
	const provider = new DeepSeekProvider({ apiKey: 'fixture', maxRetries: 0 })
	try {
		for await (const _ of provider.chatStream(params(over))) {
		}
	} catch (err) {
		return err
	}
	return undefined
}

describe('acceptsForcedToolChoiceFor', () => {
	const provider = new DeepSeekProvider({ apiKey: 'fixture' })
	it.each([
		['thinking left at the default', undefined, undefined, false],
		['an explicit enabled type', { type: 'enabled' as const }, undefined, false],
		['an explicit adaptive type', { type: 'adaptive' as const }, undefined, false],
		['a level of high', undefined, 'high' as const, false],
		['thinking disabled', { type: 'disabled' as const }, undefined, true],
		['effort none', undefined, 'none' as const, true],
		['disabled and a level', { type: 'disabled' as const }, 'low' as const, true],
	])('%s', (_name, thinking, effort, expected) => {
		expect(provider.acceptsForcedToolChoiceFor('deepseek-v4-flash', thinking, effort)).toBe(
			expected,
		)
	})
})

describe('a forced tool choice is refused before transport while thinking is on', () => {
	it.each(FORCED)('%s: no request is made', async (_name, toolChoice) => {
		const { bodies } = stubFetch()
		const err = await run({ toolChoice: toolChoice as ChatCompletionParams['toolChoice'] })
		expect(bodies).toHaveLength(0)
		expect(err).toBeInstanceOf(ProviderRequestError)
		expect(err).toMatchObject({
			kind: 'bad_request',
			providerId: 'deepseek',
			providerCode: 'forced_tool_choice_unsupported',
		})
		expect(String((err as Error).message)).toContain('toolChoice "auto"')
	})

	it('is refused for an explicit thinking type too', async () => {
		const { bodies } = stubFetch()
		const err = await run({ toolChoice: 'required', thinking: { type: 'enabled' }, effort: 'high' })
		expect(bodies).toHaveLength(0)
		expect(err).toBeInstanceOf(ProviderRequestError)
	})
})

describe('a forced tool choice goes out when thinking is off', () => {
	it.each([
		['thinking disabled', { thinking: { type: 'disabled' as const } }],
		['effort none', { effort: 'none' as const }],
	])('%s', async (_n, over) => {
		const { bodies } = stubFetch()
		await run({ toolChoice: 'required', ...over })
		expect(bodies).toHaveLength(1)
		expect(bodies[0]?.tool_choice).toBe('required')
		expect(bodies[0]?.thinking).toEqual({ type: 'disabled' })
	})
})

describe('auto and none are sent as before', () => {
	it.each(['auto', 'none'] as const)('%s with thinking on', async (toolChoice) => {
		const { bodies } = stubFetch()
		await run({ toolChoice })
		expect(bodies).toHaveLength(1)
		expect(bodies[0]?.tool_choice).toBe(toolChoice)
	})
})
