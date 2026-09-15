import type { ChatCompletionParams } from '@namzu/sdk'
import { ToolRegistry, findPortableSchemaViolations, getBuiltinTools } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { toOpenAITools } from '../client.js'

/**
 * The same gate, on the other OpenAI-shaped wire.
 *
 * This driver forwards `tool.function.parameters` verbatim, exactly as the Zen
 * driver does, and converts no dialect — so the 400 that Zen's Console gateway
 * produced for a tuple-shaped schema is available here the moment an
 * OpenAI-compatible endpoint starts validating against the JSON Schema 2020-12
 * metaschema. Nothing about this driver's wire was measured; the point of the
 * fix is that nothing has to be. What is pinned here is the precondition that
 * makes the passthrough safe.
 */

/** The function-tool half of the vendor union, which is all this driver emits. */
type FunctionTool = { function: { name: string; parameters?: unknown } }

function toolsFromTheKernel(): FunctionTool[] {
	const registry = new ToolRegistry()
	for (const tool of getBuiltinTools()) registry.register(tool)
	return toOpenAITools({
		model: 'gpt-5',
		messages: [{ role: 'user', content: 'Read the first line of README.md.' }],
		tools: registry.toLLMTools(),
	} as ChatCompletionParams) as unknown as FunctionTool[]
}

describe('the tool block an OpenAI-shaped wire receives', () => {
	it('carries no construct that wire can refuse', () => {
		const tools = toolsFromTheKernel()

		expect(tools.length).toBeGreaterThan(0)
		for (const tool of tools) {
			expect({
				[tool.function.name]: findPortableSchemaViolations(tool.function.parameters),
			}).toEqual({ [tool.function.name]: [] })
		}
	})

	it('sends `read`s range as one element schema, not a tuple', () => {
		const read = toolsFromTheKernel().find((tool) => tool.function.name === 'read')
		const { properties } = read?.function.parameters as {
			properties: Record<string, Record<string, unknown>>
		}

		expect(properties.readRange).toMatchObject({
			type: 'array',
			items: { type: 'integer', minimum: 1 },
			minItems: 2,
			maxItems: 2,
		})
		expect(Array.isArray(properties.readRange?.items)).toBe(false)
	})
})
