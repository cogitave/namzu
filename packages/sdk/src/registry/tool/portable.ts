/**
 * The schema shape every wire namzu speaks reads the same way.
 *
 * `dialect.ts` solves the problem one wire at a time: render draft-07, and let
 * each driver say it again in the dialect it knows its endpoint parses. That
 * works only where a driver HAS a measurement. Of the ten driver packages,
 * three convert; the other seven forward the rendering verbatim, because
 * nobody had measured their wires.
 *
 * One of those seven then got measured, the hard way. Its gateway validates a
 * tool's `parameters` against the JSON Schema 2020-12 metaschema, and `read`'s
 * `readRange` — the only `z.tuple(...)` in the first-party tool surface —
 * renders draft-07 as `items: [a, b]`:
 *
 *     [400] Tool 4 function has invalid 'parameters' schema:
 *     [{'minimum': 1, 'type': 'integer'}, {'minimum': 1, 'type': 'integer'}]
 *     is not of type 'object', 'boolean'
 *
 * The lesson is not "convert in five more drivers". Wiring each driver to a
 * dialect requires a measurement per wire, and the two hardest to measure are
 * precisely the ones nobody can measure on a user's behalf: the driver whose
 * schema field the vendor documents nowhere, and every compatible endpoint a
 * user points the generic HTTP driver at.
 *
 * So the kernel emits the INTERSECTION instead: the subset of JSON Schema that
 * is valid, and means the same thing, in draft-07 and in 2020-12 alike. A
 * schema in that subset needs no conversion anywhere, which is why this runs at
 * the rendering boundary rather than at ten driver boundaries.
 *
 * `toSchemaDialect` is not replaced by this and does not become dead: a driver
 * can still be handed a `parameters` object namzu never rendered (a host
 * passing `ChatCompletionParams` straight in), and converting at the boundary
 * remains the right answer there.
 */

export interface PortableSchemaViolation {
	/** Dotted path to the offending keyword, e.g. `properties.readRange.items`. */
	readonly path: string
	readonly keyword: string
	/** What to write instead. */
	readonly remedy: string
}

const NO_TUPLES =
	'say the array uniformly — one `items` schema plus `minItems`/`maxItems`; a tuple is spelled differently in draft-07 and 2020-12 and is invalid in one of them either way'

/**
 * Keywords outside the intersection, and why each one is out.
 *
 * A deny-list, like `findStrictSchemaViolations` and for the same reason: an
 * allow-list would have to enumerate every annotation a schema may carry and
 * would refuse a schema for saying something harmless.
 *
 * Every entry names a wire in the driver matrix that reads it wrong, not a
 * style preference.
 */
const OUTSIDE_THE_INTERSECTION: ReadonlyMap<string, string> = new Map([
	// 2020-12 moved the positional schemas to `prefixItems` and kept `items`
	// for the tail, so an array-valued `items` does not merely look old — it
	// means something else, and a 2020-12 validator rejects the whole request.
	// Measured on Zen's Console gateway; the quote is in this file's header.
	['additionalItems', NO_TUPLES],
	// The other spelling of the same tuple. A draft-07 validator does not know
	// the keyword, so it ignores it — which turns a constrained array into an
	// unconstrained one SILENTLY, the worse failure of the two. The strict
	// tool-input subset refuses it outright as well (`strict-schema.ts`), and
	// the function-declaration schema on one of these wires is an OpenAPI 3.0
	// subset that has never documented it.
	['prefixItems', NO_TUPLES],
	// A rendered tool schema has to stand alone. The renderer already runs with
	// `$refStrategy: 'none'`, and the MCP bridge inlines refs before handing a
	// schema out, because a wire that does not resolve them sees an empty
	// constraint or refuses the document.
	['$ref', 'inline the referenced schema; a tool schema has to stand alone'],
	['$defs', 'inline the definitions; a tool schema has to stand alone'],
	['definitions', 'inline the definitions; a tool schema has to stand alone'],
	['$id', 'drop it; a tool schema is not a retrievable document'],
	['$anchor', 'drop it; there are no references to anchor'],
	['$dynamicRef', 'inline the referenced schema; a tool schema has to stand alone'],
	['$dynamicAnchor', 'drop it; there are no references to anchor'],
	// Nothing on any wire reads it, and asserting a dialect is the one thing a
	// schema that must work in both must not do. It also rides in the tools
	// block, which renders at position 0 inside the prompt-cache prefix.
	['$schema', 'drop it; no provider reads it and it asserts a dialect'],
	// 2019-09 vocabulary. Same silent-widening hazard as `prefixItems` on a
	// draft-07 validator.
	['unevaluatedItems', 'state the constraint with `items` and `maxItems`'],
	['unevaluatedProperties', 'state the constraint with `additionalProperties`'],
])

/**
 * Every place a schema leaves the intersection, with its exact path.
 *
 * Exported so a test can sweep every shipped tool and a driver can assert
 * rather than hope. The path is the point: the vendor's error names the tool
 * index and the offending fragment but never where inside the schema it sits.
 */
export function findPortableSchemaViolations(
	schema: unknown,
	path = '',
): PortableSchemaViolation[] {
	if (Array.isArray(schema)) {
		return schema.flatMap((item, index) => findPortableSchemaViolations(item, `${path}[${index}]`))
	}
	if (typeof schema !== 'object' || schema === null) return []

	const found: PortableSchemaViolation[] = []
	for (const [keyword, value] of Object.entries(schema as Record<string, unknown>)) {
		const here = path ? `${path}.${keyword}` : keyword
		const remedy = OUTSIDE_THE_INTERSECTION.get(keyword)
		if (remedy !== undefined) {
			found.push({ path: here, keyword, remedy })
			continue
		}
		// The draft-07 tuple. Reported once, at the tuple, rather than once per
		// positional schema underneath it — one fixable finding, not a list.
		if (keyword === 'items' && Array.isArray(value)) {
			found.push({ path: here, keyword, remedy: NO_TUPLES })
			continue
		}
		// A union of types is valid JSON Schema in both dialects, but the
		// OpenAPI-3.0-shaped wires namzu speaks take a single type name and
		// either refuse a list or ignore it.
		if (keyword === 'type' && Array.isArray(value)) {
			found.push({
				path: here,
				keyword,
				remedy: 'use `anyOf` of single-typed schemas; several wires take one type name only',
			})
			continue
		}
		found.push(...findPortableSchemaViolations(value, here))
	}
	return found
}

/**
 * Rewrite what can be rewritten, so a tuple cannot reach a wire.
 *
 * Only the tuple spellings and `$schema` are rewritten. The rest of the
 * deny-list is reported and not repaired on purpose: inlining a `$ref` or
 * choosing which member of a `type` list the author meant is a guess about
 * intent, and a guess that silently changes what a tool accepts is worse than
 * the 400 it avoids. Those are caught by the profile test at the source.
 *
 * Returns the input unchanged — the SAME reference — when nothing needs
 * rewriting, which is the overwhelming common case. The tools block sits at
 * position 0 of the prompt-cache prefix, so a fresh, equal object per request
 * would invalidate the cache for the whole run.
 */
export function toPortableToolSchema(json: Record<string, unknown>): Record<string, unknown> {
	return makePortable(json) as Record<string, unknown>
}

function makePortable(value: unknown): unknown {
	if (Array.isArray(value)) {
		let changed = false
		const out = value.map((item) => {
			const next = makePortable(item)
			if (next !== item) changed = true
			return next
		})
		return changed ? out : value
	}
	if (typeof value !== 'object' || value === null) return value

	const node = value as Record<string, unknown>
	const positional = Array.isArray(node.prefixItems)
		? node.prefixItems
		: Array.isArray(node.items)
			? node.items
			: undefined
	if (positional) return collapseTuple(node, positional)

	let changed = '$schema' in node
	const out: Record<string, unknown> = {}
	for (const [key, child] of Object.entries(node)) {
		if (key === '$schema') continue
		const next = makePortable(child)
		if (next !== child) changed = true
		out[key] = next
	}
	return changed ? out : node
}

/**
 * Say a positional array uniformly.
 *
 * What is kept: the arity, and every constraint that applies to every member.
 * What is lost: which member sits where. That loss is real and it is the price
 * of a shape both dialects read identically — and it costs nothing in practice,
 * because the tool's Zod schema still parses the call and still refuses a
 * wrongly-ordered array with a message the model can act on. The wire schema is
 * a hint to the model; the parser is the contract.
 */
function collapseTuple(
	node: Record<string, unknown>,
	positional: readonly unknown[],
): Record<string, unknown> {
	// The tail rule, in whichever dialect this node happens to be written in:
	// draft-07 spells it `additionalItems`, 2020-12 spells it `items` and only
	// calls it a tail when `prefixItems` holds the members.
	const tail = Array.isArray(node.prefixItems) ? node.items : node.additionalItems
	const arity = positional.length
	const members = positional.map(makePortable)

	// A tail that is itself a schema constrains every element past the members,
	// so those elements join the uniform reading rather than closing it.
	const tailSchema =
		tail !== undefined && tail !== true && tail !== false ? makePortable(tail) : undefined
	// `false` closes the array at the members' length; so does a `maxItems` the
	// author already pinned there.
	const closed =
		tailSchema === undefined &&
		(tail === false || (typeof node.maxItems === 'number' && node.maxItems <= arity))

	// An open tail with no schema says "anything past the members", which no
	// single `items` can express alongside the members themselves. Saying
	// nothing about the elements is the only honest uniform reading; the bounds
	// below still carry whatever the author pinned.
	const candidates =
		tailSchema !== undefined ? dedupe([...members, tailSchema]) : closed ? dedupe(members) : []

	const element =
		candidates.length === 0
			? undefined
			: candidates.length === 1
				? candidates[0]
				: { anyOf: candidates }

	const out: Record<string, unknown> = {}
	for (const [key, child] of Object.entries(node)) {
		if (key === '$schema') continue
		if (key === 'additionalItems') continue
		if (key === 'prefixItems' || (key === 'items' && Array.isArray(child))) {
			if (element !== undefined) out.items = element
			continue
		}
		// The 2020-12 tail, already folded into `items` above.
		if (key === 'items' && Array.isArray(node.prefixItems)) continue
		if (key === 'maxItems' && closed && typeof child === 'number') {
			out.maxItems = Math.min(child, arity)
			continue
		}
		out[key] = makePortable(child)
	}
	// A tuple closed by `additionalItems: false` rather than by a bound loses
	// its ceiling otherwise: a uniform `items` says nothing about length, so a
	// schema written to forbid a third element would begin to allow any number.
	if (closed && out.maxItems === undefined) out.maxItems = arity
	return out
}

function dedupe(schemas: readonly unknown[]): unknown[] {
	const seen = new Set<string>()
	const out: unknown[] = []
	for (const schema of schemas) {
		const key = JSON.stringify(schema) ?? 'undefined'
		if (seen.has(key)) continue
		seen.add(key)
		out.push(schema)
	}
	return out
}
