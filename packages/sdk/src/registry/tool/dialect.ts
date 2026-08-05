/**
 * The dialect a wire speaks, and how to say the same schema in it.
 *
 * A tool has one Zod schema. What changes between providers is not the tool —
 * it is the JSON Schema dialect the wire parses, which is a property of the
 * wire. So the shape is rendered once, canonically, and each driver converts
 * at the boundary where it knows which wire it is about to talk to.
 *
 * This exists because that layering was missing and it cost a production
 * outage. `renderToolSchema` emits draft-07 (zod-to-json-schema's
 * `jsonSchema7` target), every driver forwarded it verbatim, and one of the
 * wires namzu speaks requires draft 2020-12. Measured against that live
 * endpoint:
 *
 * | tool schema                    | result                                  |
 * |--------------------------------|-----------------------------------------|
 * | `items: [a, b]`   (draft-07)   | 400 — "must match JSON Schema draft 2020-12" |
 * | `prefixItems: [a, b]` (2020-12)| accepted                                |
 * | `items: { a }`                 | accepted                                |
 *
 * The failure is NOT about strict tool use. It fires with strict validation
 * unset, and with it on the dialect error arrives *before* the strict-subset
 * error — so a guard scoped to strict misses it entirely. One was, and did.
 *
 * Which wires want which dialect is the drivers' knowledge, not this file's:
 * the vocabulary lives beside the wire that speaks it, and only the mechanism
 * lives here.
 *
 * Only the conversions namzu can actually emit are implemented. The renderer
 * runs with `$refStrategy: 'none'`, so there are no `$ref`/`definitions` to
 * rewrite; a construct that cannot appear is not worth code that cannot be
 * tested.
 */

/** Which spelling of JSON Schema a wire accepts. */
export type JsonSchemaDialect = 'draft-07' | '2020-12'

/**
 * Rendered schemas are memoized and deeply frozen, so their identity is
 * stable for the life of the tool — which makes them a sound `WeakMap` key.
 *
 * Converting per request would re-walk every tool's tree on every iteration,
 * which is the waste `renderToolSchema`'s own cache exists to remove, and it
 * would hand a fresh object to the wire each time. The tools block renders at
 * position 0 of the prompt-cache prefix, so a differently-ordered but equal
 * object still invalidates the cache for the whole run. Caching the conversion
 * keeps the bytes identical across iterations.
 */
const CONVERTED = new Map<JsonSchemaDialect, WeakMap<object, Record<string, unknown>>>()

/**
 * Say this schema in the dialect the wire parses.
 *
 * Returns the input unchanged — same reference — when nothing needs saying
 * differently, so the common case costs one map lookup and no allocation.
 */
export function toSchemaDialect(
	schema: Record<string, unknown>,
	dialect: JsonSchemaDialect,
): Record<string, unknown> {
	if (dialect === 'draft-07') return schema

	let cache = CONVERTED.get(dialect)
	if (!cache) {
		cache = new WeakMap()
		CONVERTED.set(dialect, cache)
	}
	const hit = cache.get(schema)
	if (hit) return hit

	const converted = to2020(schema) as Record<string, unknown>
	const frozen = deepFreeze(converted)
	cache.set(schema, frozen)
	return frozen
}

/**
 * Whether a schema still carries a construct the 2020-12 wire refuses.
 *
 * Exported so a test can sweep every shipped tool without reaching into the
 * conversion, and so a driver can assert rather than hope.
 */
export function findDraft07Only(schema: unknown, path = ''): string[] {
	if (Array.isArray(schema)) {
		return schema.flatMap((item, i) => findDraft07Only(item, `${path}[${i}]`))
	}
	if (typeof schema !== 'object' || schema === null) return []

	const node = schema as Record<string, unknown>
	const found: string[] = []
	// A tuple. In draft-07 the positional schemas live in `items`; 2020-12
	// moved them to `prefixItems` and kept `items` for the rest, so the array
	// form is not merely old — it means something else now, and the wire
	// rejects the whole request rather than one field.
	if (Array.isArray(node.items)) found.push(`${path ? `${path}.` : ''}items`)
	// `additionalItems` only ever qualified an array-form `items`; 2020-12
	// spells that `items`.
	if ('additionalItems' in node) found.push(`${path ? `${path}.` : ''}additionalItems`)

	for (const [key, value] of Object.entries(node)) {
		if (key === 'items' && Array.isArray(value)) continue
		found.push(...findDraft07Only(value, path ? `${path}.${key}` : key))
	}
	return found
}

function to2020(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(to2020)
	if (typeof value !== 'object' || value === null) return value

	const node = value as Record<string, unknown>
	const out: Record<string, unknown> = {}
	for (const [key, child] of Object.entries(node)) {
		if (key === 'items' && Array.isArray(child)) {
			out.prefixItems = child.map(to2020)
			continue
		}
		if (key === 'additionalItems') {
			// Only meaningful alongside an array-form `items`, and 2020-12
			// calls the same thing `items`.
			//
			// `false` is carried across, and the first version of this dropped
			// it on the reasoning that a closed tuple is 2020-12's default. It
			// is not: with `prefixItems` set and no `items`, elements past the
			// tuple are UNCONSTRAINED. Dropping the `false` therefore turned a
			// closed tuple into an open one — a schema the author wrote to
			// forbid a third element silently began to allow any. The wire
			// accepts `items: false`, measured, so nothing was gained by it.
			if (Array.isArray(node.items)) out.items = to2020(child)
			continue
		}
		out[key] = to2020(child)
	}
	return out
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
	for (const key of Object.keys(value as Record<string, unknown>)) {
		deepFreeze((value as Record<string, unknown>)[key])
	}
	return Object.freeze(value)
}
