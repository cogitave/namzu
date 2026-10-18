/**
 * A small JSON Schema validator for `agent(..., { schema })`.
 *
 * Supported keywords: `type` (string or list), `enum`, `const`, `properties`,
 * `required`, `additionalProperties` (boolean or schema), `items` (one
 * schema), `minItems`, `maxItems`, `minLength`, `maxLength`, `minimum`,
 * `maximum`, `anyOf`, `oneOf`, `allOf`. Any other keyword is ignored, and the
 * schema is also handed to the host so a model-side structured-output
 * mechanism can enforce more. `pattern` is deliberately not supported: the
 * schema is model-authored and a regular expression is a CPU risk.
 */
const MAX_DEPTH = 32

function typeOf(value: unknown): string {
	if (value === null) return 'null'
	if (Array.isArray(value)) return 'array'
	if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
	return typeof value
}

function matchesType(value: unknown, type: string): boolean {
	const actual = typeOf(value)
	return actual === type || (type === 'number' && actual === 'integer')
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

function isSchema(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function check(value: unknown, schema: unknown, path: string, depth: number): string | undefined {
	if (schema === true || schema === undefined) return undefined
	if (schema === false) return `${path}: nothing is allowed here`
	if (!isSchema(schema)) return undefined
	if (depth > MAX_DEPTH) return `${path}: schema is nested too deeply`
	const here = path || 'the result'

	const type = schema.type
	if (typeof type === 'string' && !matchesType(value, type)) {
		return `${here} must be ${type}, got ${typeOf(value)}`
	}
	if (Array.isArray(type) && !type.some((t) => typeof t === 'string' && matchesType(value, t))) {
		return `${here} must be one of ${type.join(', ')}, got ${typeOf(value)}`
	}
	if (Array.isArray(schema.enum) && !schema.enum.some((e) => same(e, value))) {
		return `${here} must be one of ${JSON.stringify(schema.enum)}`
	}
	if ('const' in schema && !same(schema.const, value)) {
		return `${here} must equal ${JSON.stringify(schema.const)}`
	}
	if (typeof value === 'string') {
		if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
			return `${here} is shorter than ${schema.minLength} characters`
		}
		if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
			return `${here} is longer than ${schema.maxLength} characters`
		}
	}
	if (typeof value === 'number') {
		if (typeof schema.minimum === 'number' && value < schema.minimum) {
			return `${here} is below ${schema.minimum}`
		}
		if (typeof schema.maximum === 'number' && value > schema.maximum) {
			return `${here} is above ${schema.maximum}`
		}
	}
	if (Array.isArray(value)) {
		if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
			return `${here} has fewer than ${schema.minItems} items`
		}
		if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
			return `${here} has more than ${schema.maxItems} items`
		}
		if (schema.items !== undefined) {
			for (const [i, item] of value.entries()) {
				const problem = check(item, schema.items, `${path}[${i}]`, depth + 1)
				if (problem) return problem
			}
		}
	}
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		const object = value as Record<string, unknown>
		if (Array.isArray(schema.required)) {
			for (const key of schema.required) {
				if (typeof key === 'string' && !Object.hasOwn(object, key)) {
					return `${here} is missing "${key}"`
				}
			}
		}
		const properties = isSchema(schema.properties) ? schema.properties : {}
		for (const [key, child] of Object.entries(object)) {
			const childPath = path ? `${path}.${key}` : key
			if (Object.hasOwn(properties, key)) {
				const problem = check(child, properties[key], childPath, depth + 1)
				if (problem) return problem
			} else if (schema.additionalProperties === false) {
				return `${here} has an unexpected property "${key}"`
			} else if (isSchema(schema.additionalProperties)) {
				const problem = check(child, schema.additionalProperties, childPath, depth + 1)
				if (problem) return problem
			}
		}
	}
	if (Array.isArray(schema.allOf)) {
		for (const part of schema.allOf) {
			const problem = check(value, part, path, depth + 1)
			if (problem) return problem
		}
	}
	if (Array.isArray(schema.anyOf) && !schema.anyOf.some((p) => !check(value, p, path, depth + 1))) {
		return `${here} matches none of the allowed shapes`
	}
	if (Array.isArray(schema.oneOf)) {
		const matching = schema.oneOf.filter((p) => !check(value, p, path, depth + 1)).length
		if (matching !== 1) return `${here} must match exactly one allowed shape, matches ${matching}`
	}
	return undefined
}

/** `undefined` when `value` satisfies `schema`, otherwise a plain sentence naming the first problem. */
export function validateAgainstSchema(value: unknown, schema: unknown): string | undefined {
	return check(value, schema, '', 0)
}

/** Parse a model's text as JSON, tolerating one surrounding code fence. */
export function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false } {
	const trimmed = text.trim()
	const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed)
	try {
		return { ok: true, value: JSON.parse(fenced ? (fenced[1] as string) : trimmed) }
	} catch {
		return { ok: false }
	}
}
