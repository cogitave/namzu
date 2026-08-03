import { describe, expect, it } from 'vitest'

import { toStrictSchema } from '../strict-schema.js'

type Node = Record<string, unknown>
const node = (value: unknown): Node => value as Node
const props = (schema: Node, name: string): Node =>
	(schema.properties as Record<string, Node>)[name] as Node

/**
 * namzu has a whole repair path for tool arguments that do not match the
 * schema — a repair hook, a bounded retry, a model-visible error. Where
 * the endpoint can constrain decoding to the schema, invalid arguments
 * stop being possible, which is strictly better than repairing them well.
 *
 * The price, and the reason it is opt-in: strict decoding requires every
 * property to be required, so an optional argument becomes one the model
 * must pass explicitly as null.
 */

describe('preparing a schema for constrained decoding', () => {
	it('closes every object, at every depth', () => {
		const out = toStrictSchema({
			type: 'object',
			properties: { nested: { type: 'object', properties: { a: { type: 'string' } } } },
		})

		expect(out.additionalProperties).toBe(false)
		expect(props(out, 'nested').additionalProperties).toBe(false)
	})

	it('requires every property', () => {
		const out = toStrictSchema({
			type: 'object',
			properties: { path: { type: 'string' }, depth: { type: 'number' } },
			required: ['path'],
		})

		expect(out.required).toEqual(['path', 'depth'])
	})

	it('keeps an optional argument optional by letting it be null', () => {
		// Otherwise making it required would silently demand a value the
		// tool never needed.
		const out = toStrictSchema({
			type: 'object',
			properties: { path: { type: 'string' }, depth: { type: 'number' } },
			required: ['path'],
		})
		expect(props(out, 'depth').type).toEqual(['number', 'null'])
		// A property that was already required is untouched — it was never
		// allowed to be absent.
		expect(props(out, 'path').type).toBe('string')
	})

	it('adds a null arm to a union rather than a type it does not have', () => {
		const out = toStrictSchema({
			type: 'object',
			properties: { either: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
		})
		const either = props(out, 'either')

		expect(either.anyOf).toEqual([{ type: 'string' }, { type: 'number' }, { type: 'null' }])
	})

	it('does not widen something that already admits null', () => {
		const out = toStrictSchema({
			type: 'object',
			properties: { maybe: { type: ['string', 'null'] } },
		})

		expect(props(out, 'maybe').type).toEqual(['string', 'null'])
	})

	it('walks into arrays and shared definitions', () => {
		const out = toStrictSchema({
			type: 'object',
			properties: { items: { type: 'array', items: { type: 'object', properties: {} } } },
			$defs: { shared: { type: 'object', properties: { x: { type: 'string' } } } },
		})

		const items = props(out, 'items') as Record<string, unknown>
		expect((items.items as Record<string, unknown>).additionalProperties).toBe(false)
		expect(node((out.$defs as Record<string, unknown>).shared).additionalProperties).toBe(false)
	})

	it('leaves the input untouched', () => {
		// Tool schemas are rendered once and cached FROZEN for the life of
		// the process, so a transform that mutated would throw on the second
		// request rather than the first.
		const input = Object.freeze({
			type: 'object',
			properties: Object.freeze({ path: Object.freeze({ type: 'string' }) }),
		})

		expect(() => toStrictSchema(input as never)).not.toThrow()
		expect(input).not.toHaveProperty('additionalProperties')
	})
})
