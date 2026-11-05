import { z } from 'zod'

/**
 * The one place a Zod schema becomes a JSON Schema document.
 *
 * Zod renders its own JSON Schema (`z.toJSONSchema`), and it is the only
 * converter that reads a Zod 4 schema: the standalone converters walk the
 * Zod 3 internals and return an empty document (`{ "$schema": ... }`) for a
 * Zod 4 tree, which would put every tool on the wire as "takes anything".
 *
 * The raw output differs from what a model has always been shown in three
 * ways that carry no information, and each would change the bytes of the
 * tools block — which sits at the head of the prompt-cache prefix — for
 * nothing. They are normalised here, once, so the wire stays what it was:
 *
 * 1. **A plain object is closed.** An object that neither allows extra keys
 *    nor declares a catch-all renders `additionalProperties: false`. Zod
 *    parses such an object by dropping unknown keys, so "closed" is the
 *    contract the model should be told. Rendering in the input direction
 *    (needed so a field with a default stays optional) omits the keyword for
 *    these; it is put back. An open object (`looseObject`, `.passthrough()`)
 *    renders `true`, not the equivalent empty schema.
 *
 * 2. **An integer is not bounded by the safe-integer range.** `.int()` adds
 *    `minimum`/`maximum` at +/- 2^53 - 1 to every integer. They restate what
 *    "integer" already means to a model and are removed. A bound the author
 *    wrote differently is kept.
 *
 * 3. **A named string format is not also a pattern.** A format such as
 *    `uuid` or `date-time` is rendered together with the very long regular
 *    expression that implements it. The format says it; the pattern is
 *    noise, and the open-API-3.0-shaped wires do not read it anyway.
 */
export type JsonSchemaTarget = 'draft-7' | 'openapi-3.0'

const MAX_SAFE = Number.MAX_SAFE_INTEGER

export function zodToJsonSchema(
	schema: z.ZodType,
	target: JsonSchemaTarget = 'draft-7',
): Record<string, unknown> {
	// A Zod 3 schema has `safeParse` and `_def`, so it passes every shape check
	// a registration makes, and then fails here with a `TypeError` about an
	// internal nobody wrote. Say what is actually wrong.
	if (typeof (schema as { _zod?: unknown })._zod !== 'object') {
		throw new TypeError(
			'This input schema was not built with Zod 4. The kernel renders and validates tool input with Zod 4 (`zod` 4 or newer); a schema from Zod 3 cannot be described to a model.',
		)
	}
	return z.toJSONSchema(schema, {
		target,
		// What a caller may send, so a field with a default stays optional.
		io: 'input',
		// A transform, a date or a bigint has no JSON form; it renders as
		// "anything" rather than failing the whole tool.
		unrepresentable: 'any',
		override: ({ zodSchema, jsonSchema }) => {
			const node = jsonSchema as Record<string, unknown>
			if (zodSchema._zod.def.type === 'object') {
				if (node.additionalProperties === undefined) node.additionalProperties = false
				else if (isEmptyObject(node.additionalProperties)) node.additionalProperties = true
			}
			if (node.type === 'integer') {
				if (node.minimum === -MAX_SAFE) delete node.minimum
				if (node.maximum === MAX_SAFE) delete node.maximum
			}
			if (typeof node.format === 'string' && typeof node.pattern === 'string') {
				delete node.pattern
			}
		},
	}) as Record<string, unknown>
}

function isEmptyObject(value: unknown): boolean {
	return typeof value === 'object' && value !== null && Object.keys(value).length === 0
}
