import type { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

/**
 * The single place a tool's Zod schema becomes the JSON Schema that goes on
 * the wire.
 *
 * Two things were wrong with converting at each call site:
 *
 * 1. **`$schema` leaked into every request.** `zodToJsonSchema` stamps
 *    `"$schema": "http://json-schema.org/draft-07/schema#"` on the root.
 *    No provider reads it, and it rides in the tools block — which renders
 *    at position 0, inside the cached prefix — once per tool, per request,
 *    forever.
 *
 * 2. **Conversion ran on the hot path.** `toLLMTools` is called once per
 *    iteration and re-walked every registered tool's Zod tree each time. A
 *    schema does not change between iterations; the work was pure waste,
 *    and worse, it made byte-stability a hope rather than a guarantee. The
 *    tools block sits at the head of the prompt-cache prefix, so a single
 *    reordered key would invalidate the entire cache for the run.
 *
 * Memoizing on the schema OBJECT (a `WeakMap`, so an unregistered tool's
 * entry is collectable) makes the rendering both free and identical across
 * iterations.
 */
const CACHE = new WeakMap<object, Record<string, unknown>>()

/**
 * Render a tool's input schema for the wire: converted once, normalized,
 * and deeply frozen.
 *
 * The freeze is not decoration. A cached object handed to a caller that
 * mutates it would poison every later render — and the symptom would be a
 * silently invalidated prompt cache, not an error. Freezing turns that
 * into a throw at the mutation site.
 */
export function renderToolSchema(schema: z.ZodType): Record<string, unknown> {
	const cached = CACHE.get(schema)
	if (cached) return cached

	const json = zodToJsonSchema(schema, {
		target: 'jsonSchema7',
		$refStrategy: 'none',
	}) as Record<string, unknown>

	const normalized = deepFreeze(normalizeToolSchema(json))
	CACHE.set(schema, normalized)
	return normalized
}

/**
 * Strip what no provider reads.
 *
 * Only `$schema` today, and only at the root — `zodToJsonSchema` does not
 * stamp it on nested nodes. Kept as a named function rather than an inline
 * `delete` so the next "providers ignore this" field has an obvious home
 * and a place to be justified.
 */
export function normalizeToolSchema(json: Record<string, unknown>): Record<string, unknown> {
	if (!('$schema' in json)) return json
	const { $schema: _dropped, ...rest } = json
	return rest
}

/**
 * Clear the render cache. Tests only — a schema object's identity is the
 * cache key, so production has nothing to invalidate.
 */
export function clearToolSchemaCache(schemas: readonly z.ZodType[]): void {
	for (const schema of schemas) CACHE.delete(schema)
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
	for (const key of Object.keys(value as Record<string, unknown>)) {
		deepFreeze((value as Record<string, unknown>)[key])
	}
	return Object.freeze(value)
}
