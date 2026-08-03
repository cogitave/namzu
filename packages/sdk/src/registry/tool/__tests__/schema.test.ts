import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { mcpJsonSchemaToZod } from '../../../connector/mcp/adapter.js'
import type { MCPJsonSchema } from '../../../types/connector/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { ToolRegistry } from '../execute.js'
import { renderToolSchema } from '../schema.js'

/**
 * The tools block renders at position 0 of every request — inside the
 * prompt-cache prefix — so its exact bytes are a contract, not an
 * implementation detail. These tests pin them.
 */

function tool(name: string, inputSchema: z.ZodType): ToolDefinition {
	return {
		name,
		description: `${name} tool`,
		inputSchema: inputSchema as ToolDefinition['inputSchema'],
		execute: () => Promise.resolve({ success: true, output: 'ok' }),
	}
}

describe('renderToolSchema', () => {
	it('drops `$schema`, which no provider reads', () => {
		// It rode in the tools block once per tool, per request, forever.
		const raw = renderToolSchema(z.object({ path: z.string() }))
		expect(raw).not.toHaveProperty('$schema')
	})

	it('pins the wire shape of an ordinary tool schema', () => {
		expect(
			renderToolSchema(
				z.object({
					path: z.string().describe('File to read'),
					limit: z.number().int().optional(),
				}),
			),
		).toEqual({
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File to read' },
				limit: { type: 'integer' },
			},
			required: ['path'],
			additionalProperties: false,
		})
	})

	it('closes nested objects and array items too', () => {
		// `additionalProperties: false` at the root only constrains the top
		// level; a model can invent keys inside a nested object otherwise.
		const json = renderToolSchema(
			z.object({ edits: z.array(z.object({ from: z.string(), to: z.string() })) }),
		) as Record<string, never>
		expect(json).toMatchObject({
			additionalProperties: false,
			properties: {
				edits: { type: 'array', items: { additionalProperties: false } },
			},
		})
	})

	it('returns the identical object for the same schema — byte-stable across iterations', () => {
		// `toLLMTools` runs once per iteration. A re-render that reordered a
		// single key would invalidate the whole cached prefix for the run.
		const schema = z.object({ a: z.string() })
		const first = renderToolSchema(schema)
		const second = renderToolSchema(schema)
		expect(second).toBe(first)
	})

	it('is frozen, so a caller cannot poison the cache', () => {
		// The symptom of a mutated cache entry would be a silently
		// invalidated prompt cache, not an error. Freezing makes it a throw.
		const rendered = renderToolSchema(z.object({ a: z.string() })) as Record<string, unknown>
		expect(() => {
			rendered.injected = true
		}).toThrow()
		expect(Object.isFrozen((rendered as { properties: object }).properties)).toBe(true)
	})

	it('renders the same object through the registry, iteration after iteration', () => {
		const registry = new ToolRegistry()
		registry.register(tool('read_file', z.object({ path: z.string() })))

		const a = registry.toLLMTools()[0]?.function.parameters
		const b = registry.toLLMTools()[0]?.function.parameters
		expect(a).toBe(b)
		expect(a).not.toHaveProperty('$schema')
	})
})

describe('MCP schema round trip', () => {
	const render = (schema: MCPJsonSchema) => renderToolSchema(mcpJsonSchemaToZod(schema))

	it('preserves a nested object instead of flattening it to "any keys"', () => {
		// This is what the model is shown for a bridged tool. Collapsing it
		// to `z.record(z.unknown())` left the model guessing at a shape the
		// server had spelled out precisely.
		const rendered = render({
			type: 'object',
			properties: {
				filter: {
					type: 'object',
					properties: { status: { type: 'string' }, limit: { type: 'integer' } },
					required: ['status'],
				},
			},
			required: ['filter'],
		} as unknown as MCPJsonSchema)

		expect(rendered).toMatchObject({
			properties: {
				filter: {
					type: 'object',
					properties: { status: { type: 'string' }, limit: { type: 'integer' } },
					required: ['status'],
				},
			},
		})
	})

	it('preserves array item types instead of "array of anything"', () => {
		const rendered = render({
			type: 'object',
			properties: { ids: { type: 'array', items: { type: 'string' } } },
		} as unknown as MCPJsonSchema)

		expect(rendered).toMatchObject({
			properties: { ids: { type: 'array', items: { type: 'string' } } },
		})
	})

	it('preserves enums, descriptions and defaults', () => {
		const rendered = render({
			type: 'object',
			properties: {
				mode: { type: 'string', enum: ['fast', 'thorough'], description: 'Search depth' },
			},
		} as unknown as MCPJsonSchema)

		expect(rendered).toMatchObject({
			properties: {
				mode: { type: 'string', enum: ['fast', 'thorough'], description: 'Search depth' },
			},
		})
	})

	it('models a nullable field rather than erasing its type', () => {
		const zod = mcpJsonSchemaToZod({
			type: 'object',
			properties: { cursor: { type: ['string', 'null'] } },
			required: ['cursor'],
		} as unknown as MCPJsonSchema)

		expect(zod.safeParse({ cursor: null }).success).toBe(true)
		expect(zod.safeParse({ cursor: 'abc' }).success).toBe(true)
		expect(zod.safeParse({ cursor: 7 }).success).toBe(false)
	})

	it('resolves anyOf to a union', () => {
		const zod = mcpJsonSchemaToZod({
			type: 'object',
			properties: { id: { anyOf: [{ type: 'string' }, { type: 'integer' }] } },
			required: ['id'],
		} as unknown as MCPJsonSchema)

		expect(zod.safeParse({ id: 'x' }).success).toBe(true)
		expect(zod.safeParse({ id: 3 }).success).toBe(true)
		expect(zod.safeParse({ id: true }).success).toBe(false)
	})

	it('tells the model it may NOT invent arguments the server never declared', () => {
		// The old default was `.passthrough()`, rendering
		// `additionalProperties: true`.
		const rendered = render({
			type: 'object',
			properties: { q: { type: 'string' } },
		} as unknown as MCPJsonSchema)
		expect(rendered).toMatchObject({ additionalProperties: false })
	})

	it('still honors a server that explicitly opens its schema', () => {
		const rendered = render({
			type: 'object',
			properties: { q: { type: 'string' } },
			additionalProperties: true,
		} as unknown as MCPJsonSchema)
		expect(rendered).toMatchObject({ additionalProperties: true })
	})

	it('validates a nested payload the old converter would have waved through', () => {
		const zod = mcpJsonSchemaToZod({
			type: 'object',
			properties: {
				filter: { type: 'object', properties: { limit: { type: 'integer' } }, required: ['limit'] },
			},
			required: ['filter'],
		} as unknown as MCPJsonSchema)

		expect(zod.safeParse({ filter: { limit: 10 } }).success).toBe(true)
		// `z.record(z.unknown())` accepted both of these.
		expect(zod.safeParse({ filter: { limit: 'ten' } }).success).toBe(false)
		expect(zod.safeParse({ filter: {} }).success).toBe(false)
	})
})
