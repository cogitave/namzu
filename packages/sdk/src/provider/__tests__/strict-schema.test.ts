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

	it('reports numeric and string bounds, which are also outside the subset', () => {
		const schema = {
			type: 'object',
			properties: {
				n: { type: 'integer', minimum: 0 },
				s: { type: 'string', maxLength: 10 },
			},
		}

		expect(
			findStrictSchemaViolations(schema)
				.map((v) => v.keyword)
				.sort(),
		).toEqual(['maxLength', 'minimum'])
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
