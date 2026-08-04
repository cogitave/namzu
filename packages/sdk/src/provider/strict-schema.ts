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
 * something harmless. These are the constructs documented as outside the
 * subset; each one names what to write instead.
 */
const NO_CONDITIONALS = 'strict mode has no conditional schemas; flatten the object'
const NO_NUMERIC_BOUNDS = 'numeric bounds are not in the subset; enforce at execution'
const NO_LENGTH_BOUNDS = 'length bounds are not in the subset; enforce at execution'

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
	['minLength', NO_LENGTH_BOUNDS],
	['maxLength', NO_LENGTH_BOUNDS],
	['minItems', NO_LENGTH_BOUNDS],
	['maxItems', NO_LENGTH_BOUNDS],
	['uniqueItems', 'array constraints are not in the subset; enforce at execution'],
	['patternProperties', 'name the properties explicitly'],
	['propertyNames', 'name the properties explicitly'],
	['dependentSchemas', 'flatten the object and validate at execution'],
	['dependentRequired', 'flatten the object and validate at execution'],
])

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
