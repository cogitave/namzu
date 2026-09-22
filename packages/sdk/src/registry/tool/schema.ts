import type { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { toPortableToolSchema } from './portable.js'

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
 *    reordered key would invalidate the entire cache for the turn.
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
 * Make the rendering something every wire reads the same way.
 *
 * Two jobs, both at this one boundary:
 *
 * 1. **Strip what no provider reads.** `$schema` rides in the tools block,
 *    which renders at position 0 inside the prompt-cache prefix, once per
 *    tool, per request, forever — and it asserts a dialect, which is the one
 *    thing a schema that has to work on every wire must not do.
 *
 * 2. **Leave the intersection of draft-07 and 2020-12 intact.** `renderToolSchema`
 *    emits draft-07, where a tuple is `items: [a, b]`; a 2020-12 wire reads
 *    that as invalid and rejects the whole request, taking every other tool in
 *    the call down with it. Five of the ten drivers forward the rendering
 *    verbatim, so the only place that can be fixed once is here. See
 *    `portable.ts` for the measurement that put it here.
 */
export function normalizeToolSchema(json: Record<string, unknown>): Record<string, unknown> {
	return toPortableToolSchema(json)
}

/**
 * The schema a tool actually puts on the wire.
 *
 * A tool may carry an explicit `modelInputSchema` — hand-written JSON Schema,
 * not rendered from Zod — and that schema reaches providers through the same
 * `tools` block as a rendered one. It therefore has to clear the same bar, and
 * the two call sites that build that block (`ToolRegistry.toLLMTools` and the
 * toolset catalog) had each spelled the fallback out on their own. Two paths
 * that agree today are two paths that can disagree tomorrow.
 *
 * The clone is deliberate: a caller may edit the parameters it is handed —
 * `hostModelSchema` does — and the definition's own object must not move
 * underneath the next call.
 */
export function toolWireSchema(tool: {
	readonly modelInputSchema?: Record<string, unknown>
	readonly inputSchema: z.ZodType
}): Record<string, unknown> {
	if (tool.modelInputSchema) return toPortableToolSchema(structuredClone(tool.modelInputSchema))
	return renderToolSchema(tool.inputSchema)
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
