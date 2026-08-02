import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { ToolRegistry, describeWithOutput } from '../../../registry/tool/execute.js'
import type { MCPToolDefinition, MCPToolResult } from '../../../types/connector/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { mcpToolResultToToolResult, mcpToolToToolDefinition } from '../adapter.js'

/**
 * Two halves of the same omission.
 *
 * `outputSchema` is unconditional: servers publish it on a tool listing
 * regardless of negotiated protocol revision, and the result type had no
 * slot for it — so a declared return shape never reached the model, which
 * was left inferring one from prose.
 *
 * `structuredContent` is conditional on a server that answers with a
 * machine-readable payload and omits the compatibility text block. When
 * that happens the model got an EMPTY tool result for a call that
 * succeeded: `isError` false, content array legitimately empty, no
 * diagnostic anywhere.
 */

const result = (partial: Partial<MCPToolResult>): MCPToolResult => ({
	content: [],
	...partial,
})

describe('a structured payload', () => {
	it('reaches the model instead of an empty result', () => {
		const converted = mcpToolResultToToolResult(
			result({ structuredContent: { temperature: 21, unit: 'C' } }),
		)

		expect(converted.success).toBe(true)
		expect(converted.output).toContain('temperature')
		expect(converted.output).toContain('21')
	})

	it('yields to the text block when the server sent one', () => {
		// The text block is what the server wrote FOR the model; the
		// structured payload is for a program. Duplicating both would spend
		// context saying the same thing twice.
		const converted = mcpToolResultToToolResult(
			result({
				content: [{ type: 'text', text: 'It is 21 degrees.' }],
				structuredContent: { temperature: 21 },
			}),
		)

		expect(converted.output).toBe('It is 21 degrees.')
	})

	it('stays reachable by the host through data', () => {
		const converted = mcpToolResultToToolResult(result({ structuredContent: { id: 7 } }))
		expect(converted.data).toEqual({ content: [], structuredContent: { id: 7 } })
	})

	it('leaves data as the content array when there is no structured payload', () => {
		// The pre-existing shape for every server that does not send one.
		const blocks = [{ type: 'text' as const, text: 'plain' }]
		expect(mcpToolResultToToolResult(result({ content: blocks })).data).toEqual(blocks)
	})

	it('names an unserializable payload rather than returning nothing', () => {
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic

		const converted = mcpToolResultToToolResult(result({ structuredContent: cyclic }))
		// An empty output reads to the model as "nothing was found", which is
		// a different answer from "this could not be rendered".
		expect(converted.output).toMatch(/could not be serialized/)
	})

	it('carries a structured error into the error field too', () => {
		const converted = mcpToolResultToToolResult(
			result({ isError: true, structuredContent: { code: 'RATE_LIMIT' } }),
		)
		expect(converted.success).toBe(false)
		expect(converted.error).toContain('RATE_LIMIT')
	})

	it('passes a plain string through without quoting it', () => {
		expect(mcpToolResultToToolResult(result({ structuredContent: 'done' })).output).toBe('done')
	})
})

describe('a declared return shape', () => {
	const tool: MCPToolDefinition = {
		name: 'forecast',
		description: 'Weather for a city',
		inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
		outputSchema: {
			type: 'object',
			properties: { temperature: { type: 'number' }, unit: { type: 'string' } },
			required: ['temperature'],
		},
	}

	it('survives the bridge', () => {
		const bridged = mcpToolToToolDefinition(tool, {} as never, 'weather')
		expect(bridged.outputSchema).toEqual(tool.outputSchema)
	})

	it('resolves its own refs', () => {
		const bridged = mcpToolToToolDefinition(
			{
				...tool,
				outputSchema: {
					type: 'object',
					properties: { at: { $ref: '#/$defs/Point' } },
					$defs: { Point: { type: 'object', properties: { lat: { type: 'number' } } } },
				},
			},
			{} as never,
			'weather',
		)

		expect(JSON.stringify(bridged.outputSchema)).not.toContain('$ref')
		expect(JSON.stringify(bridged.outputSchema)).toContain('lat')
	})

	it('reaches the model, since no provider has a slot for it', () => {
		const registry = new ToolRegistry()
		registry.register({
			name: 'forecast',
			description: 'Weather for a city',
			inputSchema: z.object({ city: z.string() }),
			outputSchema: { type: 'object', properties: { temperature: { type: 'number' } } },
			execute: async () => ({ success: true as const, output: '' }),
		} as ToolDefinition)

		const rendered = registry.toLLMTools()[0]
		expect(rendered?.function.description).toContain('Returns (JSON Schema)')
		expect(rendered?.function.description).toContain('temperature')
	})

	it('leaves a tool without one untouched', () => {
		// Every tool schema rides in the cached prefix of every request, so
		// an empty "Returns:" line would be pure waste repeated forever.
		expect(describeWithOutput('Just a tool', undefined)).toBe('Just a tool')
	})
})
