import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { findDraft07Only } from '../dialect.js'
import { findPortableSchemaViolations, toPortableToolSchema } from '../portable.js'
import { renderToolSchema } from '../schema.js'

/**
 * The normaliser, tested on its own.
 *
 * `every-shipped-tool-schema-is-portable.test.ts` proves no tool currently
 * carries the construct; this one proves what happens to one that does — which
 * is the case that matters, because the schema a future tool or a connected MCP
 * server contributes is not in that sweep.
 */

describe('collapsing a tuple into a shape both dialects read', () => {
	it('rewrites the draft-07 spelling', () => {
		expect(
			toPortableToolSchema({
				type: 'array',
				items: [
					{ type: 'integer', minimum: 1 },
					{ type: 'integer', minimum: 1 },
				],
				minItems: 2,
				maxItems: 2,
			}),
		).toEqual({
			type: 'array',
			items: { type: 'integer', minimum: 1 },
			minItems: 2,
			maxItems: 2,
		})
	})

	it('rewrites the 2020-12 spelling too', () => {
		// A hand-written `modelInputSchema` can be written in either dialect,
		// and `prefixItems` is the worse of the two to leave alone: a draft-07
		// validator does not know the keyword, so it drops the constraint
		// silently instead of complaining.
		expect(
			toPortableToolSchema({
				type: 'array',
				prefixItems: [{ type: 'integer' }, { type: 'integer' }],
				minItems: 2,
				maxItems: 2,
			}),
		).toEqual({ type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 })
	})

	it('keeps members that differ, as a union, and says so in `anyOf`', () => {
		expect(
			toPortableToolSchema({
				type: 'array',
				items: [{ type: 'string' }, { type: 'integer' }],
				minItems: 2,
				maxItems: 2,
			}),
		).toEqual({
			type: 'array',
			items: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
			minItems: 2,
			maxItems: 2,
		})
	})

	it('keeps a closed tuple closed when only `additionalItems: false` closed it', () => {
		// The ceiling is the whole constraint here. A uniform `items` says
		// nothing about length, so dropping `additionalItems` without adding
		// `maxItems` would turn a schema written to forbid a third element into
		// one that allows any number — a silent widening, which is exactly the
		// failure mode this module exists to avoid.
		expect(
			toPortableToolSchema({
				type: 'array',
				items: [{ type: 'integer' }],
				additionalItems: false,
			}),
		).toEqual({ type: 'array', items: { type: 'integer' }, maxItems: 1 })
	})

	it('folds a tail schema into the element union', () => {
		expect(
			toPortableToolSchema({
				type: 'array',
				items: [{ type: 'string' }],
				additionalItems: { type: 'integer' },
			}),
		).toEqual({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'integer' }] } })
	})

	it('says nothing about elements when the tail was unconstrained', () => {
		// `items: [A]` with no `additionalItems` constrains position 0 and
		// leaves the rest open. No single `items` can say that, and inventing
		// one would REFUSE arrays the author accepted. Dropping to "an array"
		// is the only honest uniform reading; the parser still enforces the
		// real shape at execution.
		expect(toPortableToolSchema({ type: 'array', items: [{ type: 'string' }] })).toEqual({
			type: 'array',
		})
	})

	it('reaches a tuple nested anywhere in the tree', () => {
		const collapsed = toPortableToolSchema({
			type: 'object',
			properties: {
				edits: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							span: { type: 'array', items: [{ type: 'integer' }, { type: 'integer' }] },
						},
					},
				},
			},
		})

		expect(findPortableSchemaViolations(collapsed)).toEqual([])
		expect(findDraft07Only(collapsed)).toEqual([])
	})

	it('drops `$schema`, which asserts the one thing a portable schema must not', () => {
		expect(
			toPortableToolSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' }),
		).toEqual({ type: 'object' })
	})

	it('hands back the very same object when there is nothing to rewrite', () => {
		// Not an equal object — the SAME one. The tools block sits at position 0
		// of the prompt-cache prefix; a fresh copy per request would invalidate
		// the cache for the whole turn even though the bytes matched.
		const schema = {
			type: 'object',
			properties: { path: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
		}

		expect(toPortableToolSchema(schema)).toBe(schema)
	})
})

describe('naming what a wire will refuse', () => {
	it('reports the tuple once, at the tuple', () => {
		const violations = findPortableSchemaViolations({
			type: 'object',
			properties: { range: { type: 'array', items: [{ type: 'integer' }, { type: 'integer' }] } },
		})

		expect(violations.map((v) => v.path)).toEqual(['properties.range.items'])
	})

	it('refuses both tuple spellings, not just the old one', () => {
		expect(findPortableSchemaViolations({ prefixItems: [{ type: 'integer' }] })).toHaveLength(1)
		expect(findPortableSchemaViolations({ additionalItems: false })).toHaveLength(1)
	})

	it('refuses a schema that does not stand alone', () => {
		const violations = findPortableSchemaViolations({
			$defs: { id: { type: 'string' } },
			properties: { id: { $ref: '#/$defs/id' } },
		})

		expect(violations.map((v) => v.path)).toEqual(['$defs', 'properties.id.$ref'])
	})

	it('refuses a list of types, which the OpenAPI-shaped wires take one of', () => {
		const violations = findPortableSchemaViolations({
			properties: { cursor: { type: ['string', 'null'] } },
		})

		expect(violations).toHaveLength(1)
		expect(violations[0]?.remedy).toContain('anyOf')
	})

	it('says nothing about the shapes the kernel actually renders', () => {
		expect(
			findPortableSchemaViolations({
				type: 'object',
				properties: {
					path: { type: 'string', description: 'a path' },
					readRange: {
						type: 'array',
						items: { type: 'integer', minimum: 1 },
						minItems: 2,
						maxItems: 2,
					},
					insertLine: { anyOf: [{ type: 'integer' }, { const: 'end' }] },
				},
				required: ['path'],
				additionalProperties: false,
			}),
		).toEqual([])
	})
})

describe('the rendering boundary', () => {
	it('never lets a Zod tuple out, whoever wrote it', () => {
		// The residual vector after `read` was fixed: an MCP server's own schema
		// is converted to Zod and re-rendered through this same path, so a
		// server that declares a positional array would reintroduce the exact
		// construct at a point no first-party review sees.
		const rendered = renderToolSchema(
			z.object({ span: z.tuple([z.number().int(), z.number().int()]).optional() }),
		)

		expect(rendered).toEqual({
			type: 'object',
			properties: {
				span: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
			},
			additionalProperties: false,
		})
		expect(findPortableSchemaViolations(rendered)).toEqual([])
		expect(findDraft07Only(rendered)).toEqual([])
	})

	it('still refuses the payloads the tuple refused', () => {
		// Only the SCHEMA changed. The Zod type is what parses a call, and a
		// rendering that describes a looser shape than the parser enforces is
		// only a hint the model can get wrong once.
		const parser = z.object({ span: z.tuple([z.number().int(), z.number().int()]) })

		expect(parser.safeParse({ span: [1, 2] }).success).toBe(true)
		expect(parser.safeParse({ span: [1] }).success).toBe(false)
		expect(parser.safeParse({ span: [1, 2, 3] }).success).toBe(false)
	})
})
