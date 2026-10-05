import { describe, expect, it, vi } from 'vitest'

import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { renderToolSchema } from '../../../registry/tool/schema.js'
import { query } from '../../../runtime/query/index.js'
import { type ToolReviewPrompt, createReviewHandler } from '../../../runtime/query/review-policy.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { ToolManager } from '../../../toolsets/manager.js'
import { toolset } from '../../../toolsets/toolset.js'
import type { MCPJsonSchema, MCPToolResult } from '../../../types/connector/index.js'
import type { TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { generateSessionId } from '../../../utils/id.js'
import { mcpJsonSchemaToZod, mcpToolToToolDefinition } from '../adapter.js'
import type { MCPClient } from '../client.js'

registerMock()

// Pinned application servers emit records as schema-valued additionalProperties,
// including {} for arbitrary values. These are explicit dictionary declarations,
// not permission to invent sibling arguments on ordinary closed objects.
const eventSchema = {
	type: 'object',
	properties: {
		event_type: { type: 'string', enum: ['key', 'action'] },
		event_data: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {} },
		delay_after_ms: { type: 'integer', minimum: 0 },
	},
	required: ['event_type'],
	additionalProperties: false,
}
const inputSchema: MCPJsonSchema = {
	type: 'object',
	properties: {
		events: { anyOf: [eventSchema, { type: 'array', items: eventSchema, minItems: 1 }] },
		summary: { type: 'boolean' },
	},
	required: ['events'],
	additionalProperties: false,
}

const keyPress = { event_type: 'key', event_data: { keycode: 32, pressed: true } }
const keyRelease = { event_type: 'key', event_data: { keycode: 32, pressed: false } }

describe('MCP schema-valued additionalProperties', () => {
	it.each([{ events: keyPress }, { events: [keyPress, keyRelease] }])(
		'preserves an application event through model schema, review, execution and MCP dispatch',
		async ({ events }) => {
			const args = { events, summary: true }
			const callTool = vi.fn(
				async (): Promise<MCPToolResult> => ({
					content: [{ type: 'text', text: 'application reply' }],
				}),
			)
			const tool = mcpToolToToolDefinition(
				{ name: 'input_simulate', inputSchema, annotations: { readOnlyHint: true } },
				{ callTool } as unknown as MCPClient,
				'fixture',
			)
			const source = toolset(
				{
					id: 'fixture',
					kind: 'mcp_server',
					name: 'fixture',
					mcpServer: { name: 'fixture', readOnlyHintTrusted: false },
				},
				[tool],
			)
			const manager = new ToolManager({ toolsets: [source], messages: () => [] })
			const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
			const sessionId = generateSessionId()
			const observedInputs: unknown[] = []
			const outputs: string[] = []
			for await (const event of query({
				provider: new MockLLMProvider({
					turns: [
						{
							toolCalls: [{ id: 'input-call', name: tool.name, args }],
							finishReason: 'tool_calls',
						},
						{ text: 'done' },
					],
				}),
				toolsets: [source],
				turnConfig: { model: 'mock', tokenBudget: 0, timeoutMs: 0, maxIterations: 3 },
				agentId: 'fixture',
				agentName: 'Fixture',
				messages: [createUserMessage('Send this application event')],
				resumeHandler: createReviewHandler({ mode: 'prompt', prompt, registry: manager }),
				sessionId,
				sessionLog: new InMemorySessionLog({ sessionId }),
				projectId: '38018058-7f48-4a66-8cac-67bc513451f4' as ProjectId,
				topicId: '78bd1b88-07a8-43ba-b3c1-cc02468a3781' as TopicId,
				tenantId: '56b14123-e653-4cef-ac96-21f2d79d9bbd' as TenantId,
			})) {
				if (event.type === 'tool_executing') observedInputs.push(event.input)
				if (event.type === 'tool_completed') outputs.push(event.result)
			}
			expect(observedInputs).toEqual([args])
			expect(callTool).toHaveBeenCalledWith('input_simulate', args, expect.any(Object))
			// An open argument dictionary must not make its server's read-only
			// claim trusted or change remote result provenance.
			expect(prompt).toHaveBeenCalledTimes(1)
			expect(prompt.mock.calls[0]?.[0].toolCalls[0]?.input).toEqual(args)
			expect(outputs[0]).toContain('namzu-untrusted')
			expect(outputs[0]).toContain('application reply')
			const rendered = manager.toLLMTools()[0]?.function.parameters
			expect(rendered).toMatchObject({
				additionalProperties: false,
				properties: {
					events: {
						anyOf: [
							{ properties: { event_data: { type: 'object', additionalProperties: {} } } },
							{
								items: { properties: { event_data: { type: 'object', additionalProperties: {} } } },
							},
						],
					},
				},
			})
		},
	)

	it('validates dictionary values before dispatch and retains named-field validation', async () => {
		const callTool = vi.fn(async (): Promise<MCPToolResult> => ({ content: [] }))
		const tool = mcpToolToToolDefinition(
			{
				name: 'set_weights',
				inputSchema: {
					type: 'object',
					properties: { label: { type: 'string' } },
					required: ['label'],
					additionalProperties: { type: 'integer', minimum: 0 },
				},
			},
			{ callTool } as unknown as MCPClient,
			'fixture',
		)
		const manager = new ToolManager({ toolsets: [toolset('fixture', [tool])], messages: () => [] })
		const context = { abortSignal: new AbortController().signal } as ToolContext
		for (const input of [
			{ label: 'weights', arm: 'wrong' },
			{ label: 'weights', arm: -1 },
			{ arm: 2 },
		])
			expect((await manager.execute(tool.name, input, context)).success).toBe(false)
		expect(callTool).not.toHaveBeenCalled()
		const input = { label: 'weights', arm: 2 }
		expect((await manager.execute(tool.name, input, context)).success).toBe(true)
		expect(callTool).toHaveBeenCalledWith('set_weights', input, expect.any(Object))
		expect(renderToolSchema(tool.inputSchema)).toMatchObject({
			additionalProperties: { type: 'integer', minimum: 0 },
		})
	})

	it('resolves and validates referenced dictionary value schemas', () => {
		const schema = mcpJsonSchemaToZod({
			type: 'object',
			additionalProperties: { $ref: '#/$defs/value' },
			$defs: {
				value: { type: 'object', properties: { weight: { type: 'number' } }, required: ['weight'] },
			},
		} as unknown as MCPJsonSchema)
		expect(schema.parse({ arm: { weight: 0.5 } })).toEqual({ arm: { weight: 0.5 } })
		expect(schema.safeParse({ arm: { weight: 'wrong' } }).success).toBe(false)
		expect(schema.safeParse({ arm: {} }).success).toBe(false)
	})

	it.each([undefined, false, true])(
		'retains explicit or omitted boolean policy: %s',
		(additional) => {
			const dictionary = {
				type: 'object',
				properties: { declared: { type: 'string' } },
				...(additional === undefined ? {} : { additionalProperties: additional }),
			}
			const schema = mcpJsonSchemaToZod({
				type: 'object',
				properties: { dictionary },
			} as unknown as MCPJsonSchema)
			const input = { dictionary: { declared: 'value', extra: 5 }, sibling: 'undeclared' }
			expect(schema.parse(input)).toEqual({
				dictionary: { declared: 'value', ...(additional === true ? { extra: 5 } : {}) },
			})
		},
	)

	it.each([undefined, false])(
		'keeps empty closed objects closed at the recursion boundary: %s',
		(additional) => {
			let schema: Record<string, unknown> = {
				type: 'object',
				...(additional === undefined ? {} : { additionalProperties: additional }),
			}
			let input: unknown = { undeclared: 'must strip' }
			let expected: unknown = {}
			for (let depth = 0; depth < 32; depth += 1) {
				schema = { type: 'object', additionalProperties: schema }
				input = { child: input }
				expected = { child: expected }
			}
			expect(mcpJsonSchemaToZod(schema as unknown as MCPJsonSchema).parse(input)).toEqual(expected)
		},
	)

	it('bounds deeply nested dictionary conversion without dropping an ordinary dictionary payload', () => {
		let schema: Record<string, unknown> = { type: 'string' }
		for (let depth = 0; depth < 5_000; depth += 1)
			schema = { type: 'object', additionalProperties: schema }
		expect(() => mcpJsonSchemaToZod(schema as unknown as MCPJsonSchema)).not.toThrow()
		const payload = {
			events: { event_type: 'action', event_data: { action: 'ui_accept', pressed: false } },
		}
		expect(mcpJsonSchemaToZod(inputSchema).parse(payload)).toEqual(payload)
	})
})
