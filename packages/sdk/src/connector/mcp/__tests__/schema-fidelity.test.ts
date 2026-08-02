import { describe, expect, it } from 'vitest'
import { zodToJsonSchema } from 'zod-to-json-schema'

import type { MCPJsonSchema } from '../../../types/connector/index.js'
import { mcpJsonSchemaToZod } from '../adapter.js'
import { inlineSchemaRefs } from '../schema-refs.js'

/**
 * A bridged tool's schema makes a round trip — server JSON Schema → Zod →
 * JSON Schema on the wire — so whatever the conversion drops is dropped
 * from what the MODEL is shown, not just from what is enforced.
 *
 * Two losses were total. A `$ref` hit the permissive branch and became
 * "anything"; since that node is inherently optional in Zod, a `$ref`'d
 * field the server listed as required stopped being required as well, so
 * an empty payload validated clean and reached the server. And every
 * validation keyword except `description` and `default` was discarded.
 */

const asSchema = (schema: unknown) => schema as MCPJsonSchema
/** Walking a rendered schema; every node is `unknown` at the type level. */
// biome-ignore lint/suspicious/noExplicitAny: assertions index arbitrary depth
type RenderedSchema = Record<string, any>

const render = (schema: unknown) =>
	zodToJsonSchema(mcpJsonSchemaToZod(asSchema(schema)), {
		target: 'openApi3',
	}) as RenderedSchema

describe('a schema built from $defs', () => {
	const schema = {
		type: 'object',
		properties: { location: { $ref: '#/$defs/Location' } },
		required: ['location'],
		$defs: {
			Location: {
				type: 'object',
				properties: {
					city: { type: 'string', description: 'City name' },
					lat: { type: 'number' },
				},
				required: ['city'],
			},
		},
	}

	it('shows the model the shape instead of an empty object', () => {
		const rendered = render(schema)
		expect(rendered.properties.location.type).toBe('object')
		expect(rendered.properties.location.properties.city.type).toBe('string')
		expect(rendered.properties.location.properties.city.description).toBe('City name')
	})

	it('keeps a $ref field required', () => {
		// The real damage: an unknown node is optional in Zod, so the
		// executor's "Required: <field>" hint never fired and an empty
		// payload was forwarded to the server as if it were valid.
		const parsed = mcpJsonSchemaToZod(asSchema(schema)).safeParse({})
		expect(parsed.success).toBe(false)
	})

	it('enforces the referenced shape', () => {
		const zod = mcpJsonSchemaToZod(asSchema(schema))
		expect(zod.safeParse({ location: { city: 'Ankara' } }).success).toBe(true)
		expect(zod.safeParse({ location: { lat: 39.9 } }).success).toBe(false)
	})

	it('drops the definition dictionary once its pointers are inlined', () => {
		// Asserted on the inliner's own output, not the rendered schema: the
		// Zod conversion reads only `properties`/`required`, so `$defs` could
		// never have shown up downstream and the assertion would have been
		// unable to fail.
		const inlined = inlineSchemaRefs(schema)
		expect(inlined.$defs).toBeUndefined()
		expect(Object.keys(inlined)).toEqual(['type', 'properties', 'required'])
	})

	it('reads the legacy definitions keyword too', () => {
		const rendered = render({
			type: 'object',
			properties: { who: { $ref: '#/definitions/Person' } },
			definitions: { Person: { type: 'object', properties: { name: { type: 'string' } } } },
		})
		expect(rendered.properties.who.properties.name.type).toBe('string')
	})
})

describe('pointers that cannot be followed', () => {
	it('stops at a self-referential schema instead of recursing forever', () => {
		const schema = {
			type: 'object',
			properties: { node: { $ref: '#/$defs/Node' } },
			$defs: {
				Node: {
					type: 'object',
					properties: {
						value: { type: 'string' },
						child: { $ref: '#/$defs/Node' },
					},
				},
			},
		}

		// The outer level still expands — only the repeat is cut short, so a
		// recursive type costs one branch rather than the whole document.
		const rendered = render(schema)
		expect(rendered.properties.node.properties.value.type).toBe('string')
	})

	it('expands the same pointer twice when the uses are siblings, not a cycle', () => {
		const rendered = render({
			type: 'object',
			properties: { from: { $ref: '#/$defs/P' }, to: { $ref: '#/$defs/P' } },
			$defs: { P: { type: 'object', properties: { id: { type: 'string' } } } },
		})
		expect(rendered.properties.from.properties.id.type).toBe('string')
		expect(rendered.properties.to.properties.id.type).toBe('string')
	})

	it('leaves a dangling pointer permissive rather than guessing', () => {
		expect(() =>
			render({ type: 'object', properties: { x: { $ref: '#/$defs/Missing' } } }),
		).not.toThrow()
	})

	it('leaves a pointer into another document alone', () => {
		expect(() =>
			render({ type: 'object', properties: { x: { $ref: 'https://example.test/s.json' } } }),
		).not.toThrow()
	})

	it('lets a sibling keyword override the target', () => {
		const inlined = inlineSchemaRefs({
			$defs: { P: { type: 'string', description: 'from the definition' } },
			properties: { a: { $ref: '#/$defs/P', description: 'from the use site' } },
		}) as unknown as { properties: { a: { type: string; description: string } } }

		expect(inlined.properties.a.type).toBe('string')
		expect(inlined.properties.a.description).toBe('from the use site')
	})

	it('decodes an escaped pointer token', () => {
		const inlined = inlineSchemaRefs({
			$defs: { 'a/b': { type: 'number' } },
			properties: { x: { $ref: '#/$defs/a~1b' } },
		}) as unknown as { properties: { x: { type: string } } }

		expect(inlined.properties.x.type).toBe('number')
	})
})

describe('validation keywords', () => {
	it('carries string bounds, pattern and format through', () => {
		const rendered = render({
			type: 'object',
			properties: {
				code: { type: 'string', minLength: 3, maxLength: 8, pattern: '^[A-Z]+$' },
				contact: { type: 'string', format: 'email' },
			},
		})

		expect(rendered.properties.code.minLength).toBe(3)
		expect(rendered.properties.code.maxLength).toBe(8)
		expect(rendered.properties.code.pattern).toBe('^[A-Z]+$')
		expect(rendered.properties.contact.format).toBe('email')
	})

	it('enforces them, so a bad argument is caught before the round trip', () => {
		const zod = mcpJsonSchemaToZod(
			asSchema({
				type: 'object',
				properties: { code: { type: 'string', pattern: '^[A-Z]+$' } },
				required: ['code'],
			}),
		)
		expect(zod.safeParse({ code: 'ABC' }).success).toBe(true)
		expect(zod.safeParse({ code: 'abc' }).success).toBe(false)
	})

	it('carries numeric bounds through', () => {
		const rendered = render({
			type: 'object',
			properties: {
				count: { type: 'integer', minimum: 1, maximum: 100, multipleOf: 5 },
			},
		})
		expect(rendered.properties.count.minimum).toBe(1)
		expect(rendered.properties.count.maximum).toBe(100)
		expect(rendered.properties.count.multipleOf).toBe(5)
	})

	it('carries array bounds through', () => {
		const rendered = render({
			type: 'object',
			properties: { tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 } },
		})
		expect(rendered.properties.tags.minItems).toBe(1)
		expect(rendered.properties.tags.maxItems).toBe(3)
	})

	it('ignores a pattern this engine cannot compile rather than failing to register', () => {
		// A server may use a regex dialect Node's engine rejects. An
		// unenforced pattern is a smaller loss than a tool that vanishes.
		expect(() =>
			render({ type: 'object', properties: { x: { type: 'string', pattern: '[a-' } } }),
		).not.toThrow()
	})

	it('does not invent a validator for an advisory format', () => {
		const zod = mcpJsonSchemaToZod(
			asSchema({ type: 'object', properties: { when: { type: 'string', format: 'duration' } } }),
		)
		expect(zod.safeParse({ when: 'whatever the server accepts' }).success).toBe(true)
	})
})

describe('allOf', () => {
	it('is flattened into one readable shape', () => {
		const rendered = render({
			type: 'object',
			allOf: [
				{ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
				{ type: 'object', properties: { note: { type: 'string' } } },
			],
		})

		expect(rendered.properties.id.type).toBe('string')
		expect(rendered.properties.note.type).toBe('string')
		expect(rendered.required).toEqual(['id'])
	})

	it('resolves refs inside its members', () => {
		const rendered = render({
			type: 'object',
			allOf: [{ $ref: '#/$defs/Base' }],
			$defs: { Base: { type: 'object', properties: { id: { type: 'string' } } } },
		})
		expect(rendered.properties.id.type).toBe('string')
	})
})

describe('depth', () => {
	it('converts a deeply nested schema without exhausting the stack', () => {
		let node: Record<string, unknown> = { type: 'string' }
		for (let i = 0; i < 200; i++) {
			node = { type: 'object', properties: { next: node } }
		}
		expect(() => mcpJsonSchemaToZod(asSchema(node))).not.toThrow()
	})
})
