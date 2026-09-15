import { describe, expect, it } from 'vitest'

import { toSchemaDialect } from '../../../registry/tool/dialect.js'
import { findPortableSchemaViolations } from '../../../registry/tool/portable.js'
import { renderToolSchema } from '../../../registry/tool/schema.js'
import type { MCPJsonSchema } from '../../../types/connector/index.js'
import { mcpJsonSchemaToZod } from '../adapter.js'

/**
 * A bridged tool's schema makes a round trip — server JSON Schema → Zod →
 * JSON Schema on the wire — so this file asserts what comes out the FAR end,
 * not what the Zod type is. Two failures live at that far end and neither is
 * visible from the Zod side:
 *
 *  - whatever the conversion drops is dropped from what the MODEL is shown,
 *    and a positional array was being flattened to "an array of anything";
 *  - whatever it emits has to be a construct the receiving wire accepts, and
 *    a rejected tool schema fails the WHOLE request rather than degrading one
 *    tool. So a faithful conversion that cannot be sent is worse than a lossy
 *    one that can, which is why the tuple gate is narrow rather than eager.
 *
 * The second of those got its answer the expensive way, and this file changed
 * with it. NO positional spelling is accepted everywhere: a 2020-12 wire
 * refuses `items: [a, b]`, a draft-07 one silently ignores `prefixItems`, and
 * seven of the ten drivers convert neither. So the rendering boundary collapses
 * every tuple to a uniform array, and the positions travel to the model in the
 * description instead — the one channel every wire carries intact. What the
 * assertions below pin is that both halves survive: the shape is portable, and
 * the order is still stated.
 */

function wire(schema: MCPJsonSchema): Record<string, unknown> {
	const rendered = renderToolSchema(mcpJsonSchemaToZod(schema))
	const properties = toSchemaDialect(rendered, '2020-12').properties as Record<
		string,
		Record<string, unknown>
	>
	return properties.a as Record<string, unknown>
}

const wrap = (a: Record<string, unknown>): MCPJsonSchema =>
	({ type: 'object', properties: { a }, required: ['a'] }) as unknown as MCPJsonSchema

describe('a server that pinned its positions is carried, portably', () => {
	it('sends the draft-07 spelling as a bounded uniform array', () => {
		expect(
			wire(
				wrap({
					type: 'array',
					items: [{ type: 'string' }, { type: 'number' }],
					additionalItems: false,
					minItems: 2,
					maxItems: 2,
				}),
			),
		).toEqual({
			type: 'array',
			minItems: 2,
			maxItems: 2,
			items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
			description: 'Positional array — [0] string, [1] number.',
		})
	})

	it('reaches the identical wire shape from the 2020-12 spelling', () => {
		// The two spellings say the same thing and a server may use either.
		// Converging them is the point: a bridged tool should not be shown
		// differently to the model because of which dialect its author wrote.
		expect(
			wire(
				wrap({
					type: 'array',
					prefixItems: [{ type: 'string' }, { type: 'number' }],
					items: false,
					minItems: 2,
				}),
			),
		).toEqual({
			type: 'array',
			minItems: 2,
			maxItems: 2,
			items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
			description: 'Positional array — [0] string, [1] number.',
		})
	})

	it('still parses positionally, which is where the order is enforced', () => {
		// The wire shape accepts `[1, 'a']`; the parser does not. Losing the
		// order on the wire is a weaker HINT, not a weaker contract — the call
		// is still refused, with a message the model can act on.
		const zod = mcpJsonSchemaToZod(
			wrap({
				type: 'array',
				items: [{ type: 'string' }, { type: 'number' }],
				additionalItems: false,
				minItems: 2,
				maxItems: 2,
			}),
		)

		expect(zod.safeParse({ a: ['x', 1] }).success).toBe(true)
		expect(zod.safeParse({ a: [1, 'x'] }).success).toBe(false)
		expect(zod.safeParse({ a: ['x'] }).success).toBe(false)
	})

	it('leaves nothing on the wire for a dialect to disagree about', () => {
		const rendered = renderToolSchema(
			mcpJsonSchemaToZod(
				wrap({
					type: 'array',
					items: [{ type: 'string' }, { type: 'number' }],
					additionalItems: false,
					minItems: 2,
					maxItems: 2,
				}),
			),
		)

		expect(findPortableSchemaViolations(rendered)).toEqual([])
	})
})

describe('a positional array the wire cannot carry keeps its shape in words', () => {
	it('falls back when the server did not pin the length', () => {
		// The inversion worth pinning: positional members do NOT constrain
		// length. With no `minItems` the server is permitting a SHORTER array,
		// and a tuple cannot express that — so an absent lower bound is a
		// reason to fall back rather than a detail to round up.
		const result = wire(
			wrap({
				type: 'array',
				prefixItems: [{ type: 'string' }, { type: 'number' }],
			}),
		)

		expect(result.prefixItems).toBeUndefined()
		expect(result.description).toContain('[0] string')
		expect(result.description).toContain('[1] number')
	})

	it('appends the shape to the description rather than replacing it', () => {
		// The case this exists for is a server that documented its argument
		// WELL and used a positional array. Assigning the description would
		// have deleted its sentence to make room for ours.
		const result = wire(
			wrap({
				type: 'array',
				prefixItems: [{ type: 'string' }, { type: 'number' }],
				description: 'A coordinate pair.',
			}),
		)

		expect(result.description).toContain('A coordinate pair.')
		expect(result.description).toContain('[0] string')
	})

	it('keeps the bounds the server did state', () => {
		// The fallback is a ZodArray precisely so the ordinary constraint pass
		// still carries `minItems`/`maxItems` onto it.
		const result = wire(
			wrap({ type: 'array', prefixItems: [{ type: 'string' }], minItems: 1, maxItems: 9 }),
		)

		expect(result.minItems).toBe(1)
		expect(result.maxItems).toBe(9)
	})

	it('names enums and literals in the description, not just types', () => {
		const result = wire(
			wrap({
				type: 'array',
				prefixItems: [{ enum: ['r', 'w'] }, { const: 7 }],
			}),
		)

		expect(result.description).toContain('"r"|"w"')
		expect(result.description).toContain('7')
	})
})

describe('an ordinary list is untouched', () => {
	it('still renders as a homogeneous array', () => {
		expect(wire(wrap({ type: 'array', items: { type: 'string' } }))).toEqual({
			type: 'array',
			items: { type: 'string' },
		})
	})
})

describe('a deep schema cannot take the process down', () => {
	// `MAX_CONVERSION_DEPTH` promised in its own comment that a node past the
	// ceiling is "left permissive rather than the process being taken down by
	// a stack overflow". That was false for arrays and for unions: the counter
	// was never passed down the array path, and even where it WAS passed
	// correctly — the union path — nothing compared it to anything, because
	// the only comparison lived in the object branch a pure array or union
	// never reaches. A remote server's tool listing is untrusted input, so
	// this was reachable denial of service.
	const nestArrays = (depth: number): MCPJsonSchema => {
		let inner: Record<string, unknown> = { type: 'string' }
		for (let i = 0; i < depth; i += 1) inner = { type: 'array', items: inner }
		return wrap(inner)
	}

	const nestUnions = (depth: number): MCPJsonSchema => {
		let inner: Record<string, unknown> = { type: 'string' }
		for (let i = 0; i < depth; i += 1) inner = { anyOf: [inner] }
		return wrap(inner)
	}

	it('survives a deeply nested array', () => {
		expect(() => mcpJsonSchemaToZod(nestArrays(5_000))).not.toThrow()
	})

	it('survives a deeply nested union', () => {
		expect(() => mcpJsonSchemaToZod(nestUnions(5_000))).not.toThrow()
	})

	it('still converts a shallow schema faithfully', () => {
		// The guard must not be so eager that it flattens ordinary nesting.
		const result = wire(
			wrap({ type: 'array', items: { type: 'array', items: { type: 'number' } } }),
		)

		expect(result).toEqual({
			type: 'array',
			items: { type: 'array', items: { type: 'number' } },
		})
	})
})
