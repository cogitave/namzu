import { afterEach, expect, it, vi } from 'vitest'
import { HttpProvider } from '../client.js'
afterEach(() => vi.unstubAllGlobals())
it.each(['openai', 'anthropic'] as const)(
	'maps native schema to the actual %s request',
	async (kind) => {
		let body: Record<string, any> | undefined
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				body = JSON.parse(String(init?.body))
				return new Response(JSON.stringify({ error: { message: 'fixture refusal' } }), {
					status: 400,
					headers: { 'content-type': 'application/json' },
				})
			}),
		)
		const provider = new HttpProvider({ baseURL: 'https://fixture.test/v1', dialect: kind })
		expect(provider.capabilities.supportsNativeStructuredOutput).toBe(true)
		const schema = {
			type: 'object',
			properties: { score: { type: 'number' } },
			required: ['score'],
			additionalProperties: false,
		}
		await expect(async () => {
			for await (const _ of provider.chatStream({
				model: 'fixture-model',
				messages: [{ role: 'user', content: 'Score' }],
				responseFormat: {
					type: 'json_schema',
					json_schema: { name: 'score', schema, strict: true },
				},
			})) {
			}
		}).rejects.toBeDefined()
		expect(body).toBeDefined()
		const request = body as Record<string, any>
		const actual =
			kind === 'anthropic'
				? request.output_config?.format?.schema
				: request.response_format?.json_schema?.schema
		expect(actual).toEqual(schema)
	},
)
