import type { ChatCompletionParams, ProviderRoute } from '@namzu/sdk'
import { ToolRegistry, findPortableSchemaViolations, getBuiltinTools } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import type { ZenProtocol } from '../models.js'
import { createCallOptions } from '../options.js'

/**
 * What this driver actually puts on the wire, for every protocol it speaks.
 *
 * The incident: `muse-spark-1.3-contributor-free` is a `responses` model, and
 * Zen's Console gateway validates a tool's `parameters` against the JSON Schema
 * 2020-12 metaschema. `read.readRange` was a `z.tuple`, which the kernel
 * rendered as the draft-07 `items: [a, b]`, and this driver forwarded verbatim:
 *
 *     [400] Tool 4 function has invalid 'parameters' schema:
 *     [{'minimum': 1, 'type': 'integer'}, {'minimum': 1, 'type': 'integer'}]
 *     is not of type 'object', 'boolean'
 *
 * The whole request is refused, so one field in one tool killed the turn.
 *
 * This driver is a passthrough by design — four protocols multiplexed through
 * one options builder, and it converts no dialect for any of them. That is not
 * the defect and this test does not change it: what the test pins is that the
 * schema it is HANDED is already something every one of those four wires reads
 * the same way. A driver that forwards a portable schema needs no measurement
 * of its wire, which is the only scalable answer for an endpoint behind a
 * gateway nobody here controls.
 *
 * Built from the real registry rather than a fixture, deliberately: a fixture
 * pins what someone believed the kernel renders, and the belief is the thing
 * that was wrong.
 */

const PROTOCOLS: ZenProtocol[] = ['chat', 'responses', 'messages', 'google']

function toolsFromTheKernel(): NonNullable<ChatCompletionParams['tools']> {
	const registry = new ToolRegistry()
	for (const tool of getBuiltinTools()) registry.register(tool)
	return registry.toLLMTools()
}

function requestTools(protocol: ZenProtocol, model: string) {
	const params: ChatCompletionParams = {
		model,
		messages: [{ role: 'user', content: 'Read the first line of README.md.' }],
		tools: toolsFromTheKernel(),
	}
	const route: ProviderRoute = { providerId: 'zen', model, chainIndex: 0 }
	const options = createCallOptions(params, route, 'zen', protocol)
	return (options.tools ?? []) as { name: string; inputSchema: Record<string, unknown> }[]
}

describe('the tool block Zen receives', () => {
	it.each(PROTOCOLS)('carries no construct a %s wire can refuse', (protocol) => {
		const tools = requestTools(protocol, 'muse-spark-1.3-contributor-free')

		expect(tools.length).toBeGreaterThan(0)
		for (const tool of tools) {
			expect({ [tool.name]: findPortableSchemaViolations(tool.inputSchema) }).toEqual({
				[tool.name]: [],
			})
		}
	})

	it('sends `read`s range as one element schema, on the model that reported the 400', () => {
		// The exact model from the report, and the exact field the gateway
		// quoted back.
		const tools = requestTools('responses', 'muse-spark-1.3-contributor-free')
		const read = tools.find((tool) => tool.name === 'read')
		const properties = read?.inputSchema.properties as Record<string, Record<string, unknown>>

		expect(properties.readRange).toMatchObject({
			type: 'array',
			items: { type: 'integer', minimum: 1 },
			minItems: 2,
			maxItems: 2,
		})
		expect(Array.isArray(properties.readRange?.items)).toBe(false)
	})

	it('forwards the kernel rendering byte for byte', () => {
		// The driver adds `strict` and renames the field; it must not otherwise
		// touch the schema. If it ever starts to, the portability guarantee
		// stops being the kernel's to make.
		const kernel = toolsFromTheKernel()
		const tools = requestTools('chat', 'big-pickle')

		for (const tool of tools) {
			const source = kernel.find((candidate) => candidate.function.name === tool.name)
			expect(tool.inputSchema).toEqual(source?.function.parameters)
		}
	})
})
