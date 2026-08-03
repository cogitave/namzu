import { afterEach, describe, expect, it, vi } from 'vitest'

import { HttpProvider } from '../client.js'
import type { HttpDialect } from '../types.js'

/**
 * `toolChoice: 'none'` means the model must not call a tool.
 *
 * The second dialect has no native "none", and this driver answered that by
 * sending "auto" — which says the model MAY. A caller that had forbidden
 * tool use got a request that permitted it, with nothing in the response to
 * say so. The runtime depends on the guarantee: an advisory consultation
 * passes `'none'` so the advisor answers in prose, into a turn where no
 * executor is waiting for a tool call.
 *
 * A model cannot call a tool it was never given, on any version of any wire
 * format, so `'none'` now sends no tools at all.
 */

afterEach(() => {
	vi.unstubAllGlobals()
})

const TOOLS = [
	{
		type: 'function' as const,
		function: { name: 'read', description: 'read a file', parameters: { type: 'object' } },
	},
]

/** Captures the request body the driver would put on the wire. */
async function bodyFor(
	dialect: HttpDialect,
	toolChoice: 'none' | 'auto' | 'required' | undefined,
): Promise<Record<string, unknown>> {
	let captured: Record<string, unknown> = {}
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: RequestInit) => {
			captured = JSON.parse(String(init.body))
			return new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
		}),
	)

	const provider = new HttpProvider({ baseURL: 'https://example.test/v1', apiKey: 'k', dialect })
	for await (const _chunk of provider.chatStream({
		model: 'm',
		messages: [{ role: 'user', content: 'hi' }],
		tools: TOOLS,
		...(toolChoice !== undefined ? { toolChoice } : {}),
	})) {
		// drain
	}
	return captured
}

describe("the second dialect answers 'none' by sending no tools", () => {
	it('omits the tool list', async () => {
		const body = await bodyFor('anthropic', 'none')

		expect(body.tools).toBeUndefined()
	})

	it('does not claim the model may choose one', async () => {
		const body = await bodyFor('anthropic', 'none')

		// The bug in one line: this used to be `{ type: 'auto' }`.
		expect(body.tool_choice).toBeUndefined()
	})

	it('still sends the tools for every other choice', async () => {
		expect((await bodyFor('anthropic', 'auto')).tools).toHaveLength(1)
		expect((await bodyFor('anthropic', 'required')).tools).toHaveLength(1)
		expect((await bodyFor('anthropic', undefined)).tools).toHaveLength(1)
	})

	it('still maps the other choices onto the wire', async () => {
		expect((await bodyFor('anthropic', 'auto')).tool_choice).toEqual({ type: 'auto' })
		expect((await bodyFor('anthropic', 'required')).tool_choice).toEqual({ type: 'any' })
	})
})

describe("the first dialect already understood 'none' natively", () => {
	it('passes it through rather than reinterpreting it', async () => {
		const body = await bodyFor('openai', 'none')

		expect(body.tool_choice).toBe('none')
	})
})
