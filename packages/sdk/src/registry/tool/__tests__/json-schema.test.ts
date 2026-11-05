import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { zodToJsonSchema } from '../json-schema.js'

/**
 * What a model is told about a tool's input is the rendering below, so each
 * assertion names a thing the model would otherwise see differently.
 */
describe('zodToJsonSchema', () => {
	it('tells the model a plain object is closed, and an open one is open', () => {
		const closed = zodToJsonSchema(z.object({ a: z.string() }))
		const open = zodToJsonSchema(z.object({ a: z.string() }).passthrough())
		const dictionary = zodToJsonSchema(z.object({}).catchall(z.number()))
		expect(closed.additionalProperties).toBe(false)
		expect(open.additionalProperties).toBe(true)
		expect(dictionary.additionalProperties).toEqual({ type: 'number' })
	})

	it('keeps a field with a default optional', () => {
		const json = zodToJsonSchema(z.object({ a: z.string().default('x'), b: z.string() }))
		expect(json.required).toEqual(['b'])
		expect((json.properties as Record<string, unknown>).a).toEqual({ type: 'string', default: 'x' })
	})

	it('does not bound an integer by the safe-integer range, and keeps a bound the author wrote', () => {
		const json = zodToJsonSchema(
			z.object({ n: z.number().int(), m: z.number().int().min(1).max(10) }),
		)
		const props = json.properties as Record<string, Record<string, unknown>>
		expect(props.n).toEqual({ type: 'integer' })
		expect(props.m).toEqual({ type: 'integer', minimum: 1, maximum: 10 })
	})

	it('states a named format without the expression that implements it', () => {
		const json = zodToJsonSchema(
			z.object({
				id: z.string().uuid(),
				at: z.string().datetime(),
				plain: z.string().regex(/^a$/),
			}),
		)
		const props = json.properties as Record<string, Record<string, unknown>>
		expect(props.id).toEqual({ type: 'string', format: 'uuid' })
		expect(props.at).toEqual({ type: 'string', format: 'date-time' })
		expect(props.plain?.pattern).toBe('^a$')
	})

	it('renders what has no JSON form as anything instead of failing the tool', () => {
		const json = zodToJsonSchema(
			z.object({ when: z.date(), n: z.string().transform((s) => s.length) }),
		)
		const props = json.properties as Record<string, unknown>
		expect(props.when).toEqual({})
		expect(props.n).toEqual({ type: 'string' })
	})

	it('renders the OpenAPI 3.0 spelling of a nullable on request', () => {
		const json = zodToJsonSchema(z.object({ a: z.string().nullable() }), 'openapi-3.0')
		expect((json.properties as Record<string, unknown>).a).toEqual({
			type: 'string',
			nullable: true,
		})
		expect(json.$schema).toBeUndefined()
	})

	it('refuses a schema from another major version of Zod with a message that names the cause', () => {
		const zod3Shaped = { safeParse: () => ({ success: true }), _def: { typeName: 'ZodObject' } }
		expect(() => zodToJsonSchema(zod3Shaped as unknown as z.ZodType)).toThrow(/Zod 4/)
	})
})
