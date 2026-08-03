import { describe, expect, it } from 'vitest'

import { toBedrockToolConfig } from '../client.js'

/**
 * `toolChoice: 'none'` means the model must not call a tool. This driver
 * mapped it to the wire's "auto", which means the model MAY — the exact
 * opposite of what the caller asked for, and silent.
 *
 * The runtime relies on it: an advisory consultation passes `'none'` so the
 * advisor answers in prose. Under this driver the advisor could emit a tool
 * call instead, into a turn with no executor waiting for one.
 *
 * The fix is not a better mapping. Every version of every wire format
 * agrees a model cannot call a tool it was never given, so `'none'` sends
 * no tools at all — a guarantee rather than a request.
 */

const TOOLS = [
	{
		type: 'function' as const,
		function: { name: 'read', description: 'read a file', parameters: { type: 'object' } },
	},
]

describe("a caller that said 'none' gets no tools on the wire", () => {
	it('omits the tool config entirely', () => {
		expect(
			toBedrockToolConfig({ model: 'm', messages: [], tools: TOOLS, toolChoice: 'none' }),
		).toBe(undefined)
	})

	it('omits it even when the history contains tool blocks', () => {
		const config = toBedrockToolConfig({
			model: 'm',
			messages: [
				{
					role: 'assistant',
					content: null,
					toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
				},
				{ role: 'tool', content: 'ok', toolCallId: 'c1' },
			] as Parameters<typeof toBedrockToolConfig>[0]['messages'],
			toolChoice: 'none',
		})

		expect(config).toBe(undefined)
	})
})

describe('the other choices still reach the wire unchanged', () => {
	it('maps auto', () => {
		const config = toBedrockToolConfig({
			model: 'm',
			messages: [],
			tools: TOOLS,
			toolChoice: 'auto',
		})
		expect(config?.toolChoice).toEqual({ auto: {} })
		expect(config?.tools).toHaveLength(1)
	})

	it('maps required', () => {
		const config = toBedrockToolConfig({
			model: 'm',
			messages: [],
			tools: TOOLS,
			toolChoice: 'required',
		})
		expect(config?.toolChoice).toEqual({ any: {} })
	})

	it('maps a named tool', () => {
		const config = toBedrockToolConfig({
			model: 'm',
			messages: [],
			tools: TOOLS,
			toolChoice: { type: 'function', function: { name: 'read' } },
		})
		expect(config?.toolChoice).toEqual({ tool: { name: 'read' } })
	})

	it('defaults to auto when the caller said nothing', () => {
		const config = toBedrockToolConfig({ model: 'm', messages: [], tools: TOOLS })
		expect(config?.toolChoice).toEqual({ auto: {} })
	})
})
