/**
 * Which JSON Schema a driver may mark as strictly validated.
 *
 * Strict tool input is not "JSON Schema, enforced" — it is a SUBSET of JSON
 * Schema, and a keyword outside that subset does not degrade. The vendor
 * rejects the entire request, so one unexpressible field in one tool takes down
 * every tool in the call and the turn dies before a single token is produced.
 *
 * This exists because that happened. A tool declared its integer-or-`"end"`
 * field as `oneOf`, which is outside the subset while its synonym `anyOf` is
 * inside it, and the driver marked the tool strict without ever asking whether
 * the schema it was vouching for could be said in that dialect. Measured
 * against the live API: strict + `oneOf` is a 400, strict + `anyOf` is
 * accepted, and non-strict + `oneOf` is accepted.
 *
 * That last row is why nothing caught it. Neither half is wrong on its own —
 * the schema is valid JSON Schema and the strict decision is correct policy —
 * so no test of either one fails. Only the pairing does, and the pairing had no
 * owner until this function.
 *
 * The check is cheap and runs where the pairing is made, which is the only
 * place both facts are in hand.
 */

/**
 * Keywords the strict subset does not accept.
 *
 * A deny-list rather than an allow-list, deliberately. An allow-list would have
 * to enumerate every annotation a schema may carry — `description`, `title`,
 * `examples`, vendor extensions — and would refuse a schema for saying
 * something harmless. Each entry names what to write instead.
 *
 * MEASURED against the live API, not read off a page. The first version of this
 * list was derived from documentation and was wrong in both directions: it
 * refused `minLength`/`maxLength`, which the wire accepts, and it permitted
 * `prefixItems`, which the wire rejects. A deny-list nobody probed is a guess
 * with a confident tone, and this one would have refused working tools while
 * still letting a broken one through.
 *
 * The probe lives in the live contract test; run it against a new model before
 * trusting this list on that model.
 */
const NO_CONDITIONALS = 'strict mode has no conditional schemas; flatten the object'
const NO_NUMERIC_BOUNDS = 'numeric bounds are not in the subset; enforce at execution'
const NO_ARRAY_BOUNDS = 'array bounds are not in the subset; enforce at execution'

// A Map rather than an object literal, because one of the keys is `then`: an
// ordinary object carrying a `then` property is a thenable, and awaiting it
// anywhere would silently call the string. The lint rule that says so is
// right, and a Map has no such hazard.
const UNSUPPORTED: ReadonlyMap<string, string> = new Map([
	['oneOf', 'use `anyOf` — for disjoint branches the two are equivalent'],
	['not', 'express the constraint positively, or validate it at execution'],
	['if', NO_CONDITIONALS],
	['then', NO_CONDITIONALS],
	['else', NO_CONDITIONALS],
	['minimum', NO_NUMERIC_BOUNDS],
	['maximum', NO_NUMERIC_BOUNDS],
	['exclusiveMinimum', NO_NUMERIC_BOUNDS],
	['exclusiveMaximum', NO_NUMERIC_BOUNDS],
	['multipleOf', NO_NUMERIC_BOUNDS],
	// `minLength`/`maxLength` are NOT here. The first version of this list put
	// them here on documentation alone, and measurement says the wire accepts
	// both — so the list was refusing tools that would have worked. A deny-list
	// derived from prose and never probed is a guess with a confident tone.
	// `minItems` is NOT a flat denial — see MIN_ITEMS_ALLOWED below. The wire
	// accepts 0 and 1 and refuses everything above, naming the value in the
	// error, so a blanket entry here would refuse `.nonempty()` on a schema the
	// wire would have taken.
	['maxItems', NO_ARRAY_BOUNDS],
	['uniqueItems', NO_ARRAY_BOUNDS],
	// The other direction of the same mistake: this was missing, and it is the
	// one that interacts with the dialect conversion. A tuple becomes
	// `prefixItems` for the 2020-12 wire — and strict rejects `prefixItems`
	// outright, so a tool that is BOTH strict AND tuple-shaped cannot be
	// expressed at all. Better to say that at registration than to convert a
	// schema into a different rejection.
	['prefixItems', 'strict arrays take one `items` schema; a tuple cannot be expressed'],
	['patternProperties', 'name the properties explicitly'],
	['propertyNames', 'name the properties explicitly'],
	['dependentSchemas', 'flatten the object and validate at execution'],
	['dependentRequired', 'flatten the object and validate at execution'],
])

/**
 * The only `minItems` values the strict subset admits.
 *
 * Measured: `minItems: 0` and `minItems: 1` are accepted, `minItems: 2` comes
 * back *"For 'array' type, 'minItems' values other than 0 or 1 are not
 * supported"*. So the constraint is on the VALUE, not the keyword, and that is
 * the whole difference between refusing a required-non-empty array — the
 * ordinary spelling of `z.array(...).nonempty()` — and letting it through.
 */
const MIN_ITEMS_ALLOWED = new Set([0, 1])

export interface StrictSchemaViolation {
	/** Dotted path to the offending keyword, e.g. `properties.insertLine.oneOf`. */
	readonly path: string
	readonly keyword: string
	/** What to write instead. */
	readonly remedy: string
}

/**
 * Every place a schema leaves the strict subset, with its exact path.
 *
 * The path is the point. The vendor's own error names the tool and the
 * keyword but not where inside the schema it sits, which on a schema of any
 * size is the difference between a glance and an afternoon.
 */
export function findStrictSchemaViolations(schema: unknown, path = ''): StrictSchemaViolation[] {
	if (Array.isArray(schema)) {
		return schema.flatMap((item, index) => findStrictSchemaViolations(item, `${path}[${index}]`))
	}
	if (typeof schema !== 'object' || schema === null) return []

	const found: StrictSchemaViolation[] = []
	for (const [keyword, value] of Object.entries(schema as Record<string, unknown>)) {
		const here = path ? `${path}.${keyword}` : keyword
		const remedy = UNSUPPORTED.get(keyword)
		if (remedy !== undefined) {
			found.push({ path: here, keyword, remedy })
			continue
		}
		// `additionalProperties` is admitted only as `false`; any schema there
		// is an open object, which the subset does not allow.
		if (keyword === 'additionalProperties' && value !== false) {
			found.push({
				path: here,
				keyword,
				remedy: 'strict objects must set `additionalProperties: false`',
			})
			continue
		}
		// A tuple in the OTHER spelling. This check runs at registration, on the
		// schema as rendered — which is draft-07, where a tuple is `items: [a,
		// b]` — while the wire sees the 2020-12 `prefixItems` the driver
		// converts it to. So a `prefixItems` entry alone never fires on the
		// path that produces tuples, and the entry added to catch this case was
		// dead for exactly the case it was added for.
		//
		// Both spellings mean the same thing and strict admits neither, so this
		// names the tuple rather than the dialect it happens to be written in.
		if (keyword === 'items' && Array.isArray(value)) {
			found.push({
				path: here,
				keyword,
				remedy: 'strict arrays take one `items` schema; a tuple cannot be expressed',
			})
			continue
		}
		if (keyword === 'minItems' && typeof value === 'number' && !MIN_ITEMS_ALLOWED.has(value)) {
			found.push({
				path: here,
				keyword,
				remedy: 'strict accepts `minItems` of 0 or 1 only; enforce a larger bound at execution',
			})
			continue
		}
		// Every branch of a union has to state its `type`.
		//
		// `anyOf` is in the subset but its BRANCHES are still schemas, and a
		// branch that says only `{ const: 'end' }` says what value it admits
		// without saying what kind of value it is. Measured on the Zen
		// free-tier gateway, which enforces `strict` on every model that
		// reaches it: the answer is `Invalid schema for function 'edit': In
		// context=('properties', 'insertLine', 'anyOf', '1'), schema must have
		// a 'type' key`, and it refuses the whole request — so the tool never
		// mounts and the turn dies before a single token.
		//
		// This is the structural half the deny-list could not see: no keyword
		// here is banned, only absent. Stating the type costs nothing, because
		// `{ type: 'string', const: 'end' }` admits exactly the strings the
		// bare form did.
		if ((keyword === 'anyOf' || keyword === 'allOf') && Array.isArray(value)) {
			for (const [index, branch] of value.entries()) {
				if (
					typeof branch !== 'object' ||
					branch === null ||
					Array.isArray(branch) ||
					!('type' in branch)
				) {
					found.push({
						path: `${here}[${index}]`,
						keyword,
						remedy: 'state a `type` on every branch of a union',
					})
				}
			}
		}
		found.push(...findStrictSchemaViolations(value, here))
	}
	return found
}

/**
 * Refuse a schema the driver is about to vouch for and cannot.
 *
 * Refusing here rather than dropping `strict` quietly: a caller who set
 * `enforceModelInput` asked for the guarantee, and silently not providing it
 * is the failure this repo names `refuse, do not degrade`. The alternative
 * costs a turn and teaches nothing — the vendor's 400 arrives with the tool
 * name and the keyword, but not the path, and not the fix.
 */
export function assertStrictSchema(toolName: string, schema: unknown): void {
	const violations = findStrictSchemaViolations(schema)
	if (violations.length === 0) return

	const detail = violations.map((v) => `  ${toolName}.${v.path} — ${v.remedy}`).join('\n')
	throw new Error(
		`Tool "${toolName}" is marked for strict input validation, but its model-facing schema uses ${violations.length} construct(s) the strict subset does not accept. The request would be rejected whole, taking every other tool in it down as well.\n${detail}`,
	)
}

/**
 * Whether a wire enforcing `strict` would actually take this schema.
 *
 * Wider than {@link findStrictSchemaViolations}, and the difference is not
 * redundancy. That function answers "can this schema be SAID in the strict
 * dialect" — it denies keywords the dialect has no spelling for, and it is
 * what registration checks, because a schema that fails it could never be
 * sent anywhere. A schema can pass it and still be REFUSED by a wire that
 * applies the dialect's structural rules on top, and the two questions have
 * different owners: registration decides whether a tool may ask for the
 * guarantee at all, a driver decides whether to claim it on THIS wire.
 *
 * The structural rule measured here: every object that declares `properties`
 * must list all of them in `required`. The Zen free-tier gateway says so in
 * as many words — `In context=('properties', 'edits', 'items'), 'required' is
 * required to be supplied and to be an array including every key in
 * properties` — and it refuses the WHOLE request, so one optional field in one
 * tool takes every other tool in the call down with it.
 *
 * That is why a driver must ask rather than assume. Namzu's tool contracts are
 * written with optional fields, on purpose: `edit` accepts a find-and-replace
 * OR an insertion, and saying "either, never both" as `required` on a union
 * would be a worse schema, not a stricter one. So the schema stays as it is
 * and the driver stops vouching for a guarantee the wire cannot carry — the
 * same call the Zen driver already makes for the Responses wire, and the one
 * OpenCode makes for every tool on this gateway (`strict: false`).
 */
export function acceptsStrictSchema(schema: unknown): boolean {
	// A missing schema cannot be vouched for. `findStrictSchemaViolations`
	// walks nothing in `undefined` and finds nothing, so without this the
	// predicate would answer `true` for a tool that declared no schema at all
	// — and the driver would put `strict: true` on a wire whose `parameters`
	// came from somewhere else entirely.
	if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return false
	if (findStrictSchemaViolations(schema).length > 0) return false
	return !hasUngatedProperties(schema)
}

/**
 * Whether any object declares `properties` without requiring all of them.
 */
function hasUngatedProperties(node: unknown): boolean {
	if (Array.isArray(node)) return node.some((item) => hasUngatedProperties(item))
	if (typeof node !== 'object' || node === null) return false

	const record = node as Record<string, unknown>
	const properties = record.properties
	if (
		typeof properties === 'object' &&
		properties !== null &&
		!Array.isArray(properties) &&
		(!Array.isArray(record.required) ||
			Object.keys(properties).some((key) => !(record.required as unknown[]).includes(key)))
	)
		return true

	return Object.values(record).some((value) => hasUngatedProperties(value))
}
