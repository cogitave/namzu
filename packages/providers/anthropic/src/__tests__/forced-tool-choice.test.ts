import type { ChatCompletionParams, ThinkingConfig, ToolChoice } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { AnthropicProvider } from '../client.js'
import { acceptsForcedToolChoice } from '../tool-choice.js'

/**
 * A forced tool choice used to go to the wire whatever the model. Claude Opus
 * 5.5, Claude Fable 5.1 and Claude Mythos 5.1 answer it with
 * `tool_choice: type "tool" and "any" are not supported for this model.`, and
 * manual extended thinking rejects it on every model that has it. So the
 * request was a guaranteed 400, sent anyway — where an effort level the model
 * lacks is refused before sending, with a message that says what to do.
 *
 * The rows are the vendor's "Forcing tool use" table: the three models refuse
 * it regardless of thinking, manual thinking refuses it everywhere, and
 * adaptive thinking does not block it.
 */

const GET_WEATHER = {
	type: 'function' as const,
	function: {
		name: 'get_weather',
		description: 'Current weather for a city',
		parameters: {
			type: 'object',
			properties: { city: { type: 'string' } },
			required: ['city'],
		},
	},
}

const NAMED: ToolChoice = { type: 'function', function: { name: 'get_weather' } }

function providerWithCapturedRequest(): {
	readonly provider: AnthropicProvider
	readonly create: ReturnType<typeof vi.fn>
	readonly seen: { body?: Record<string, unknown> }
} {
	const seen: { body?: Record<string, unknown> } = {}
	const provider = new AnthropicProvider({ apiKey: 'test-key' })
	const create = vi.fn(async (body: Record<string, unknown>) => {
		seen.body = body
		return (async function* () {
			yield {
				type: 'message_start',
				message: { id: 'b3c5d0e2-6f41-4c8e-9a37-2f1d8e6b4a90' },
			}
		})()
	})
	;(provider as unknown as { client: { messages: { create: unknown } } }).client = {
		messages: { create },
	}
	return { provider, create, seen }
}

async function send(
	params: Partial<ChatCompletionParams>,
): Promise<{ create: ReturnType<typeof vi.fn>; body?: Record<string, unknown> }> {
	const { provider, create, seen } = providerWithCapturedRequest()
	for await (const _chunk of provider.chatStream({
		model: 'claude-opus-5-5',
		messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
		tools: [GET_WEATHER],
		...params,
	} as ChatCompletionParams)) {
		// drain
	}
	return { create, body: seen.body }
}

async function refusal(params: Partial<ChatCompletionParams>): Promise<{
	readonly error: unknown
	readonly create: ReturnType<typeof vi.fn>
}> {
	const { provider, create } = providerWithCapturedRequest()
	try {
		for await (const _chunk of provider.chatStream({
			model: 'claude-opus-5-5',
			messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
			tools: [GET_WEATHER],
			...params,
		} as ChatCompletionParams)) {
			// drain
		}
	} catch (error) {
		return { error, create }
	}
	throw new Error('expected the request to be refused')
}

describe('which models take a forced tool choice', () => {
	const rows: readonly [string, ThinkingConfig | undefined, boolean][] = [
		// Refused whatever the thinking settings.
		['claude-opus-5-5', undefined, false],
		['claude-fable-5-1', undefined, false],
		['claude-mythos-5-1', undefined, false],
		['anthropic/claude-opus-5-5', undefined, false],
		// A floor per family, so the next release in each is covered.
		['claude-opus-6', undefined, false],
		['claude-fable-5-2', undefined, false],
		// The releases below the line still take it. Fable 5 cannot stop
		// thinking and accepts a forced choice all the same, so this is not
		// the always-on line.
		['claude-opus-5', undefined, true],
		['claude-opus-5', { type: 'adaptive' }, true],
		['claude-fable-5', undefined, true],
		['claude-mythos-5', undefined, true],
		['claude-sonnet-5', undefined, true],
		// Manual thinking refuses it on every model that has it, decided on
		// what is actually sent: an `enabled` intent on an adaptive-only model
		// goes out as `adaptive` and is fine, and an `adaptive` intent on a
		// manual-only model goes out as `enabled` and is not.
		['claude-sonnet-5', { type: 'enabled', budgetTokens: 2048 }, true],
		['claude-opus-4-6', { type: 'adaptive' }, true],
		['claude-opus-4-6', { type: 'enabled', budgetTokens: 2048 }, false],
		['claude-sonnet-4-5', undefined, true],
		['claude-sonnet-4-5', { type: 'disabled' }, true],
		['claude-sonnet-4-5', { type: 'enabled', budgetTokens: 2048 }, false],
		['claude-sonnet-4-5', { type: 'adaptive' }, false],
	]

	it.each(rows)('%s with thinking %j: %s', (model, thinking, accepted) => {
		expect(acceptsForcedToolChoice(model, thinking)).toBe(accepted)
	})
})

describe('a forced choice the wire would refuse is refused before sending', () => {
	it.each([
		['required', 'required' as ToolChoice],
		['a named function', NAMED],
	])('refuses %s on Opus 5.5, naming what to use instead', async (_label, toolChoice) => {
		const { error, create } = await refusal({ toolChoice })

		expect(error).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'bad_request',
			providerId: 'anthropic',
			providerCode: 'forced_tool_choice_unsupported',
		})
		expect((error as Error).message).toMatch(/does not accept a forced tool choice/)
		expect((error as Error).message).toMatch(/toolChoice "auto"/)
		expect(create).not.toHaveBeenCalled()
	})

	it('refuses a forced choice alongside manual thinking, and says which it was', async () => {
		const { error, create } = await refusal({
			model: 'claude-sonnet-4-5',
			thinking: { type: 'enabled', budgetTokens: 2048 },
			toolChoice: 'required',
		})

		expect(error).toMatchObject({ providerCode: 'forced_tool_choice_unsupported' })
		expect((error as Error).message).toMatch(/manual extended thinking/)
		expect(create).not.toHaveBeenCalled()
	})
})

describe('everything else still reaches the wire', () => {
	it('sends auto and none to Opus 5.5', async () => {
		expect((await send({ toolChoice: 'auto' })).body?.tool_choice).toEqual({ type: 'auto' })
		expect((await send({ toolChoice: 'none' })).body?.tool_choice).toEqual({ type: 'none' })
	})

	it('keeps parallel control on auto, which is how one call at most is asked for', async () => {
		const { body } = await send({ parallelToolCalls: false })
		expect(body?.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true })
	})

	it('sends a forced choice to Opus 5, which takes it', async () => {
		const { body } = await send({ model: 'claude-opus-5', toolChoice: 'required' })
		expect(body?.tool_choice).toEqual({ type: 'any' })

		const named = await send({ model: 'claude-opus-5', toolChoice: NAMED })
		expect(named.body?.tool_choice).toEqual({ type: 'tool', name: 'get_weather' })
	})

	it('does not refuse a forced choice that never goes out', async () => {
		// With no function tools there is no `tool_choice` on the wire at all,
		// so there is nothing for the model to refuse.
		const { create, body } = await send({ tools: undefined, toolChoice: 'required' })
		expect(create).toHaveBeenCalledTimes(1)
		expect(body?.tool_choice).toBeUndefined()
	})
})

describe('the answer is reachable from the package entry', () => {
	it('exports acceptsForcedToolChoice', async () => {
		const entry = await import('../index.js')
		expect(entry.acceptsForcedToolChoice('claude-opus-5-5')).toBe(false)
		expect(entry.acceptsForcedToolChoice('claude-opus-5')).toBe(true)
	})
})
