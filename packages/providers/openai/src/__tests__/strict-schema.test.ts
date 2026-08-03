import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { toOpenAITools } from '../client.js'

/**
 * `enforceToolInputSchema` names the tools whose model-facing schema should
 * be enforced by constrained generation rather than merely suggested.
 *
 * Both sibling drivers consumed it. This one dropped it on the floor, so a
 * caller who had asked for a guaranteed-valid tool input silently got a
 * best-effort one, and learned about it from a repair attempt rather than
 * from an error. This is the wire the flag maps onto most directly — it
 * takes the flag on the function itself.
 */

const TOOLS = [
	{
		type: 'function' as const,
		function: {
			name: 'read',
			description: 'read a file',
			parameters: { type: 'object', properties: { path: { type: 'string' } } },
		},
	},
	{
		type: 'function' as const,
		function: { name: 'write', description: 'write a file', parameters: { type: 'object' } },
	},
]

type FunctionTool = {
	function: { name: string; description?: string; parameters?: unknown; strict?: boolean }
}

function toolsFor(enforceToolInputSchema?: readonly string[]): FunctionTool[] | undefined {
	return toOpenAITools({
		model: 'm',
		messages: [],
		tools: TOOLS,
		...(enforceToolInputSchema ? { enforceToolInputSchema } : {}),
	} as ChatCompletionParams) as unknown as FunctionTool[] | undefined
}

describe('the schema of a named tool is enforced, not suggested', () => {
	it('marks the tool the caller named', () => {
		const tools = toolsFor(['read'])

		expect(tools?.find((t) => t.function.name === 'read')?.function.strict).toBe(true)
	})

	it('leaves every other tool alone', () => {
		const tools = toolsFor(['read'])

		// Enforcement is not free and not always possible; marking a tool
		// nobody asked about changes behaviour the caller did not ask to
		// change.
		expect(tools?.find((t) => t.function.name === 'write')?.function).not.toHaveProperty('strict')
	})

	it('marks several when several were named', () => {
		const tools = toolsFor(['read', 'write'])

		expect(tools?.every((t) => t.function.strict === true)).toBe(true)
	})

	it('marks nothing when the hint is absent', () => {
		expect(toolsFor()?.some((t) => 'strict' in t.function)).toBe(false)
	})

	it('marks nothing when the hint names no tool', () => {
		expect(toolsFor([])?.some((t) => 'strict' in t.function)).toBe(false)
	})

	it('ignores a name that matches no registered tool', () => {
		const tools = toolsFor(['nonexistent'])

		expect(tools).toHaveLength(2)
		expect(tools?.some((t) => 'strict' in t.function)).toBe(false)
	})
})

describe('the rest of the tool schema is untouched', () => {
	it('keeps the name, description and parameters', () => {
		const read = toolsFor(['read'])?.find((t) => t.function.name === 'read')

		expect(read?.function.description).toBe('read a file')
		expect(read?.function.parameters).toMatchObject({
			type: 'object',
			properties: { path: { type: 'string' } },
		})
	})

	it('substitutes an empty object for missing parameters', () => {
		const tools = toOpenAITools({
			model: 'm',
			messages: [],
			tools: [{ type: 'function', function: { name: 'ping' } }],
		} as unknown as ChatCompletionParams) as unknown as FunctionTool[]

		expect(tools?.[0]?.function.parameters).toEqual({})
	})

	it('sends no tools at all when there are none', () => {
		expect(toOpenAITools({ model: 'm', messages: [] } as ChatCompletionParams)).toBeUndefined()
		expect(
			toOpenAITools({ model: 'm', messages: [], tools: [] } as ChatCompletionParams),
		).toBeUndefined()
	})
})
