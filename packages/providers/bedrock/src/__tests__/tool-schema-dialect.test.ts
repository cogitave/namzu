import { findDraft07Only } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { toBedrockToolConfig } from '../client.js'

/**
 * Converse carries Claude, so it carries Claude's schema dialect too.
 *
 * The kernel renders tool schemas as draft-07, where a tuple is
 * `items: [a, b]`. Anthropic's serving layer validates `input_schema` as JSON
 * Schema 2020-12, where that spelling is invalid — the tuple has to be
 * `prefixItems` — and it rejects the whole request rather than ignoring the
 * field, so one tuple-shaped tool takes down every tool in the call.
 *
 * That fix landed on the direct Anthropic driver and on the HTTP driver's
 * Anthropic branch, and this driver was missed. It reaches the same models
 * through a different front door; the validation happens in the same place.
 *
 * The conversion follows the MODEL, not the endpoint, because Converse is
 * multi-vendor: `meta.llama*` and `mistral.*` come through this same function,
 * and nothing establishes that they read 2020-12. Converting their schemas
 * would be trading a known break for an unmeasured one.
 */

const TUPLE_TOOL = [
	{
		type: 'function' as const,
		function: {
			name: 'read',
			description: 'reads',
			parameters: {
				type: 'object',
				properties: {
					// What `z.tuple([z.number(), z.number()])` renders to.
					readRange: {
						type: 'array',
						items: [{ type: 'number' }, { type: 'number' }],
						minItems: 2,
						maxItems: 2,
					},
				},
			},
		},
	},
]

function rangeOf(model: string): Record<string, unknown> {
	const config = toBedrockToolConfig({ model, messages: [], tools: TUPLE_TOOL })
	const json = config?.tools?.[0]?.toolSpec?.inputSchema?.json as Record<string, unknown>
	const properties = json.properties as Record<string, Record<string, unknown>>
	return properties.readRange as Record<string, unknown>
}

function schemaOf(model: string): Record<string, unknown> {
	const config = toBedrockToolConfig({ model, messages: [], tools: TUPLE_TOOL })
	return config?.tools?.[0]?.toolSpec?.inputSchema?.json as Record<string, unknown>
}

describe('a tuple reaches Claude on Converse in the dialect Claude reads', () => {
	it.each([
		['anthropic.claude-sonnet-4-20250514', 'a bare vendor id'],
		['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'behind an inference profile'],
		['EU.Anthropic.Claude-Opus-4-1-v1:0', 'in whatever case the caller wrote'],
	])('converts for %s (%s)', (model) => {
		expect(findDraft07Only(schemaOf(model))).toEqual([])

		const range = rangeOf(model)
		expect(range.prefixItems).toHaveLength(2)
		expect(range.items).toBeUndefined()
	})

	it('leaves another vendor on this wire alone', () => {
		// Not timidity — the absence of a measurement. Anthropic's requirement
		// was measured against its own wire; no such reading exists for these,
		// and converting on a guess swaps a known break for an unknown one.
		const range = rangeOf('meta.llama3-70b-instruct-v1:0')

		expect(range.items).toHaveLength(2)
		expect(range.prefixItems).toBeUndefined()
	})

	it('does not disturb a schema with no tuple in it', () => {
		const config = toBedrockToolConfig({
			model: 'anthropic.claude-sonnet-4-20250514',
			messages: [],
			tools: [
				{
					type: 'function',
					function: {
						name: 'ls',
						description: 'lists',
						parameters: {
							type: 'object',
							properties: { path: { type: 'string' } },
							required: ['path'],
						},
					},
				},
			],
		})

		expect(config?.tools?.[0]?.toolSpec?.inputSchema?.json).toEqual({
			type: 'object',
			properties: { path: { type: 'string' } },
			required: ['path'],
		})
	})
})
