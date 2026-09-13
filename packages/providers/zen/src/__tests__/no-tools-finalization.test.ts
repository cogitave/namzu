import { type ChatCompletionParams, collectChatCompletion } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { ZenProvider } from '../client.js'

const model = 'muse-spark-1.3-contributor-free'
const tool = {
	type: 'function' as const,
	function: {
		name: 'read',
		description: 'Read a file',
		parameters: { type: 'object', properties: {} },
	},
}
afterEach(() => vi.unstubAllGlobals())

it.each(['none', 'auto', 'required', { type: 'function', function: { name: 'read' } }] as const)(
	'encodes Responses tool choice %j without weakening requested tools',
	async (choice) => {
		const requests: Record<string, unknown>[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>(async (_input, init) => {
				const body = JSON.parse(String(init?.body))
				requests.push(body)
				if (body.tool_choice === 'none') return new Response('only auto supported', { status: 400 })
				return new Response(
					[
						{ type: 'response.created', response: { id: 'test-response', model, created_at: 1 } },
						{
							type: 'response.output_item.added',
							output_index: 0,
							item: { type: 'message', id: 'message-1' },
						},
						{ type: 'response.output_text.delta', item_id: 'message-1', delta: 'ready' },
						{
							type: 'response.output_item.done',
							output_index: 0,
							item: { type: 'message', id: 'message-1' },
						},
						{
							type: 'response.completed',
							response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
						},
					]
						.map((x) => `data: ${JSON.stringify(x)}\n\n`)
						.join(''),
					{ headers: { 'content-type': 'text/event-stream' } },
				)
			}),
		)
		const params: ChatCompletionParams = {
			model,
			messages: [{ role: 'user', content: 'Say ready.' }],
			tools: [tool],
			toolChoice: choice,
		}
		const result = await collectChatCompletion(new ZenProvider().chatStream(params))
		expect(result.message.content).toBe('ready')
		expect(requests).toHaveLength(1)
		const body = requests[0]
		if (choice === 'none') {
			expect(body).not.toHaveProperty('tools')
			expect(body).not.toHaveProperty('tool_choice')
		} else {
			expect(body?.tools).toHaveLength(1)
			expect(body?.tool_choice).toEqual(
				typeof choice === 'string' ? choice : { type: 'function', name: 'read' },
			)
		}
	},
)
