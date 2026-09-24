import { describe, expect, it } from 'vitest'

import { acceptsForcedToolChoice } from '../tool-choice.js'

/**
 * The forced-tool-choice table, checked against the wire it describes.
 *
 * `tool-choice.ts` lists the models that refuse `tool_choice` `any`/`tool`
 * from the vendor's documentation, not from a probe. This asks the wire, both
 * ways: the model the table says refuses it does, and the one below it that
 * the table says takes it does.
 *
 * Skipped without a key. Validation happens before generation, so each
 * request is `max_tokens: 1` and costs at most one token.
 */

const KEY = process.env.ANTHROPIC_API_KEY

const REFUSING_MODEL = 'claude-opus-5-5'
const ACCEPTING_MODEL = 'claude-opus-5'

async function sendForced(model: string): Promise<string | true> {
	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'x-api-key': KEY as string,
			'anthropic-version': '2023-06-01',
			'content-type': 'application/json',
		},
		body: JSON.stringify({
			model,
			max_tokens: 1,
			messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
			tools: [
				{
					name: 'get_weather',
					description: 'Current weather for a city',
					input_schema: {
						type: 'object',
						properties: { city: { type: 'string' } },
						required: ['city'],
					},
				},
			],
			tool_choice: { type: 'any' },
		}),
	})
	if (res.ok) return true
	const body: unknown = await res.json().catch(() => ({}))
	return (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`
}

describe.skipIf(!KEY)('the table and the wire agree on forced tool choice', () => {
	it('refuses it on Opus 5.5', async () => {
		expect(acceptsForcedToolChoice(REFUSING_MODEL)).toBe(false)
		expect(await sendForced(REFUSING_MODEL)).toMatch(/tool_choice/)
	}, 120_000)

	it('takes it on Opus 5, with thinking on by default', async () => {
		expect(acceptsForcedToolChoice(ACCEPTING_MODEL)).toBe(true)
		expect(await sendForced(ACCEPTING_MODEL)).toBe(true)
	}, 120_000)
})
