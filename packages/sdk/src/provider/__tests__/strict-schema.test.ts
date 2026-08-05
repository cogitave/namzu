import { describe, expect, it } from 'vitest'

import { getBuiltinTools } from '../../tools/builtins/index.js'
import { assertStrictSchema, findStrictSchemaViolations } from '../strict-schema.js'

/**
 * Strict tool input validates against a SUBSET of JSON Schema, and a keyword
 * outside that subset is not degraded — the vendor rejects the entire request,
 * so one unexpressible field in one tool takes down every tool in the call and
 * the turn dies before producing a token.
 *
 * That shipped. The edit tool declared its integer-or-`"end"` field with
 * `oneOf`, which is outside the subset while the equivalent `anyOf` is inside
 * it, and the driver marked the tool strict without asking whether the schema
 * it was vouching for could be said in that dialect.
 *
 * Measured against the live API:
 *
 * | body                   | result   |
 * |------------------------|----------|
 * | strict: true  + oneOf  | 400      |
 * | strict: false + oneOf  | accepted |
 * | strict: true  + anyOf  | accepted |
 *
 * The middle row is why nothing caught it. Neither half is wrong alone — the
 * schema is valid JSON Schema, and turning strict on is correct policy — so no
 * test of either one fails. Only the pairing does, and the pairing had no
 * owner. The sweep below is that owner.
 */

describe('every tool that asks for strict validation can be expressed strictly', () => {
	// The regression test that matters. Checking only the tool that broke
	// would leave the next one to be found in production, which is how this
	// one was found.
	it.each(
		getBuiltinTools()
			.filter((t) => t.enforceModelInput)
			.map((t) => [t.name, t] as const),
	)('%s', (name, tool) => {
		const violations = findStrictSchemaViolations(tool.modelInputSchema)
		expect(violations, violations.map((v) => `${name}.${v.path}: ${v.remedy}`).join('\n')).toEqual(
			[],
		)
	})

	it('found at least one tool to check', () => {
		// Guards the sweep itself: a filter that matches nothing passes
		// vacuously, and a rename of `enforceModelInput` would silently turn
		// this whole file into a no-op.
		expect(getBuiltinTools().filter((t) => t.enforceModelInput).length).toBeGreaterThan(0)
	})
})

describe('the violation report names the exact path', () => {
	it('points at the keyword inside a nested property', () => {
		const schema = {
			type: 'object',
			properties: {
				insertLine: { oneOf: [{ type: 'integer' }, { const: 'end' }] },
			},
		}

		expect(findStrictSchemaViolations(schema)).toEqual([
			{
				path: 'properties.insertLine.oneOf',
				keyword: 'oneOf',
				remedy: 'use `anyOf` — for disjoint branches the two are equivalent',
			},
		])
	})

	it('accepts the anyOf spelling of the same union', () => {
		const schema = {
			type: 'object',
			properties: {
				insertLine: { anyOf: [{ type: 'integer' }, { const: 'end' }] },
			},
		}

		expect(findStrictSchemaViolations(schema)).toEqual([])
	})

	it('reports the bounds the wire refuses, and only those', () => {
		// Measured against the live API rather than read off a page. The first
		// version of this list was derived from documentation and was wrong in
		// both directions: it refused `maxLength`, which the wire accepts, and
		// permitted `prefixItems`, which it rejects.
		const schema = {
			type: 'object',
			properties: {
				n: { type: 'integer', minimum: 0 },
				s: { type: 'string', maxLength: 10 },
				a: { type: 'array', items: { type: 'string' }, maxItems: 3, minItems: 1 },
			},
		}

		expect(
			findStrictSchemaViolations(schema)
				.map((v) => v.keyword)
				.sort(),
		).toEqual(['maxItems', 'minimum'])
	})

	it('leaves string length alone, because strict accepts it', () => {
		// The false positive that would have refused tools which work.
		expect(
			findStrictSchemaViolations({ s: { type: 'string', minLength: 1, maxLength: 9 } }),
		).toEqual([])
	})

	it('catches a tuple in either spelling, because strict admits neither', () => {
		// The interaction worth pinning, and the one a `prefixItems` entry alone
		// got wrong. This check runs at REGISTRATION, on the schema as rendered
		// — draft-07, where a tuple is `items: [a, b]` — while the wire sees the
		// `prefixItems` the driver converts it to. So denying only `prefixItems`
		// was a guard that could not fire on the path that produces tuples.
		//
		// Measured, strict rejects both, which is why a tool that is both strict
		// and tuple-shaped cannot be expressed at all. Converting it only
		// changes which error comes back.
		for (const items of [
			{ prefixItems: [{ type: 'integer' }, { type: 'integer' }] },
			{ items: [{ type: 'integer' }, { type: 'integer' }] },
		]) {
			const violations = findStrictSchemaViolations({
				properties: { range: { type: 'array', ...items } },
			})

			expect(violations, JSON.stringify(items)).toHaveLength(1)
			expect(violations[0]?.remedy).toContain('tuple cannot be expressed')
		}
	})

	it('leaves an ordinary array alone, where `items` is one schema', () => {
		// The false positive the tuple rule must not become: `items` is the
		// normal spelling for a homogeneous array and strict accepts it. Only
		// the array-of-schemas form is a tuple.
		expect(findStrictSchemaViolations({ type: 'array', items: { type: 'string' } })).toEqual([])
	})

	it('admits minItems at 0 or 1 and refuses it above, as the wire does', () => {
		// A blanket denial here was a false positive with a real cost: it
		// refuses `z.array(...).nonempty()`, which renders `minItems: 1` and
		// which the wire accepts. The constraint is on the VALUE, and the
		// vendor's error says so — "'minItems' values other than 0 or 1 are not
		// supported".
		expect(findStrictSchemaViolations({ type: 'array', minItems: 0 })).toEqual([])
		expect(findStrictSchemaViolations({ type: 'array', minItems: 1 })).toEqual([])

		const violations = findStrictSchemaViolations({ type: 'array', minItems: 2 })
		expect(violations).toHaveLength(1)
		expect(violations[0]?.keyword).toBe('minItems')
	})

	it('admits additionalProperties only as false', () => {
		expect(findStrictSchemaViolations({ additionalProperties: false })).toEqual([])
		expect(findStrictSchemaViolations({ additionalProperties: { type: 'string' } })).toHaveLength(1)
	})

	it('walks into arrays of subschemas', () => {
		const schema = { anyOf: [{ type: 'string' }, { not: { type: 'null' } }] }

		expect(findStrictSchemaViolations(schema)[0]?.path).toBe('anyOf[1].not')
	})

	it('leaves ordinary annotations alone', () => {
		const schema = {
			type: 'object',
			description: 'a tool',
			properties: { a: { type: 'string', description: 'x', enum: ['y'] } },
			required: ['a'],
			additionalProperties: false,
		}

		expect(findStrictSchemaViolations(schema)).toEqual([])
	})
})

describe('assertStrictSchema refuses rather than letting the request go', () => {
	it('throws naming the tool, the path and the fix', () => {
		expect(() => assertStrictSchema('edit', { properties: { insertLine: { oneOf: [] } } })).toThrow(
			/edit\.properties\.insertLine\.oneOf/,
		)
	})

	it('says nothing about a schema that is expressible', () => {
		expect(() => assertStrictSchema('edit', { type: 'object' })).not.toThrow()
	})
})
