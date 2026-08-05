import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { findDraft07Only, toSchemaDialect } from '../dialect.js'
import { renderToolSchema } from '../schema.js'

/**
 * The mechanism, tested in the kernel that owns it.
 *
 * The drivers each have their own test proving the conversion reaches their
 * wire. This one is about the conversion itself: what it rewrites, what it
 * deliberately leaves alone, and the two properties the prompt cache depends
 * on — a stable reference and a frozen result.
 */

describe('saying a schema in the dialect a wire parses', () => {
	it('moves a tuple from `items` to `prefixItems`', () => {
		const draft07 = {
			type: 'object',
			properties: {
				range: {
					type: 'array',
					items: [{ type: 'integer' }, { type: 'integer' }],
					minItems: 2,
					maxItems: 2,
				},
			},
		}

		expect(toSchemaDialect(draft07, '2020-12')).toEqual({
			type: 'object',
			properties: {
				range: {
					type: 'array',
					prefixItems: [{ type: 'integer' }, { type: 'integer' }],
					minItems: 2,
					maxItems: 2,
				},
			},
		})
	})

	it('leaves a homogeneous array alone, where `items` means the same thing', () => {
		// The distinction the whole conversion turns on: `items` is only a
		// tuple when it holds an ARRAY of schemas. One schema means "every
		// element", which both dialects spell identically.
		const schema = { type: 'array', items: { type: 'string' } }

		expect(toSchemaDialect(schema, '2020-12')).toEqual(schema)
	})

	it('turns `additionalItems` into the 2020-12 `items`', () => {
		// `additionalItems` only ever qualified an array-form `items` — it says
		// what the elements AFTER the tuple look like. 2020-12 gave that job to
		// `items` once `prefixItems` holds the positional schemas.
		const converted = toSchemaDialect(
			{
				type: 'array',
				items: [{ type: 'integer' }],
				additionalItems: { type: 'string' },
			},
			'2020-12',
		)

		expect(converted).toEqual({
			type: 'array',
			prefixItems: [{ type: 'integer' }],
			items: { type: 'string' },
		})
	})

	it('drops `additionalItems: false`, which both dialects already imply', () => {
		// Not a lossy shortcut: once `prefixItems` is set, a closed tuple is the
		// default in 2020-12, so emitting `items: false` would add a byte to
		// every request to say what was already true.
		expect(
			toSchemaDialect(
				{ type: 'array', items: [{ type: 'integer' }], additionalItems: false },
				'2020-12',
			),
		).toEqual({ type: 'array', prefixItems: [{ type: 'integer' }] })
	})

	it('ignores `additionalItems` with no tuple to qualify', () => {
		// Meaningless in draft-07 too, so carrying it forward would be inventing
		// a constraint the author did not write.
		expect(
			toSchemaDialect(
				{ type: 'array', items: { type: 'string' }, additionalItems: { type: 'integer' } },
				'2020-12',
			),
		).toEqual({ type: 'array', items: { type: 'string' } })
	})

	it('converts a tuple nested inside another tuple', () => {
		const converted = toSchemaDialect(
			{ type: 'array', items: [{ type: 'array', items: [{ type: 'integer' }] }] },
			'2020-12',
		) as Record<string, Record<string, unknown>[]>

		expect(converted.prefixItems?.[0]).toEqual({
			type: 'array',
			prefixItems: [{ type: 'integer' }],
		})
	})

	it('hands back the very same object for draft-07', () => {
		// Not an equal object — the SAME one. The tools block sits at position 0
		// of the prompt-cache prefix, so a driver that speaks draft-07 must not
		// pay an allocation or risk a differently-ordered copy per request.
		const schema = { type: 'object' }

		expect(toSchemaDialect(schema, 'draft-07')).toBe(schema)
	})

	it('returns the same converted object every time it is asked', () => {
		// Same reason. Conversion runs once per schema per dialect; a fresh
		// object each iteration would invalidate the cache for the whole run
		// even though the bytes were equal.
		const schema = { type: 'array', items: [{ type: 'integer' }] }

		expect(toSchemaDialect(schema, '2020-12')).toBe(toSchemaDialect(schema, '2020-12'))
	})

	it('freezes what it hands out, all the way down', () => {
		// A caller that mutates a cached schema would poison every later render,
		// and the symptom would be a silently invalidated prompt cache rather
		// than an error. Freezing turns that into a throw at the mutation site.
		const converted = toSchemaDialect(
			{ type: 'object', properties: { a: { type: 'array', items: [{ type: 'integer' }] } } },
			'2020-12',
		) as { properties: { a: { prefixItems: unknown[] } } }

		expect(Object.isFrozen(converted)).toBe(true)
		expect(Object.isFrozen(converted.properties.a)).toBe(true)
		expect(Object.isFrozen(converted.properties.a.prefixItems)).toBe(true)
	})
})

describe('finding what a 2020-12 wire will refuse', () => {
	it('names the path to an array-form `items`', () => {
		expect(
			findDraft07Only({
				type: 'object',
				properties: { range: { type: 'array', items: [{ type: 'integer' }] } },
			}),
		).toEqual(['properties.range.items'])
	})

	it('names `additionalItems` too', () => {
		expect(findDraft07Only({ additionalItems: false })).toEqual(['additionalItems'])
	})

	it('walks into arrays, indexing the branch', () => {
		expect(
			findDraft07Only({
				anyOf: [{ type: 'string' }, { type: 'array', items: [{ type: 'integer' }] }],
			}),
		).toEqual(['anyOf[1].items'])
	})

	it('does not descend into a tuple it has already reported', () => {
		// Reporting the tuple and then each of its positional schemas would
		// turn one fixable finding into a list nobody reads.
		expect(
			findDraft07Only({ type: 'array', items: [{ type: 'integer' }, { type: 'string' }] }),
		).toEqual(['items'])
	})

	it('says nothing about a schema that is already 2020-12', () => {
		expect(
			findDraft07Only({
				type: 'array',
				prefixItems: [{ type: 'integer' }],
				items: { type: 'string' },
			}),
		).toEqual([])
	})

	it('tolerates the leaves', () => {
		expect(findDraft07Only(null)).toEqual([])
		expect(findDraft07Only('a string')).toEqual([])
		expect(findDraft07Only(42)).toEqual([])
	})
})

describe('the round trip a real tool takes', () => {
	it('renders a Zod tuple as draft-07 and converts it clean', () => {
		// The actual defect, end to end: this is what `read.readRange` is.
		const rendered = renderToolSchema(
			z.object({ readRange: z.tuple([z.number(), z.number()]).optional() }),
		)

		expect(findDraft07Only(rendered)).not.toEqual([])
		expect(findDraft07Only(toSchemaDialect(rendered, '2020-12'))).toEqual([])
	})
})
