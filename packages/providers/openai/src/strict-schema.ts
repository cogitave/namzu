/**
 * Close a tool schema hard enough for guaranteed-valid arguments.
 *
 * This wire format offers a mode where the endpoint constrains decoding
 * to the schema, so the arguments it emits cannot be invalid. namzu has a
 * whole repair path — `repairToolCall`, a bounded retry, a model-visible
 * error — for arguments that are. Where the guarantee is available it
 * makes that path unreachable, which is strictly better than repairing
 * well.
 *
 * The mode has a price, and it is why this is opt-in rather than on:
 * every property must appear in `required`, so an optional argument
 * becomes one the model must pass explicitly as `null`. That changes what
 * the model is told, which is a decision the tool's author owns.
 *
 * The transform is mechanical:
 *  1. every object closes (`additionalProperties: false`),
 *  2. every property is required,
 *  3. a property that was NOT required widens to accept null, so "leave
 *     it out" stays expressible as "pass nothing for it".
 */

type Schema = Record<string, unknown>

const isSchema = (value: unknown): value is Schema =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/** Widen a type to admit null without disturbing anything else. */
function nullable(schema: Schema): Schema {
	const type = schema.type
	if (typeof type === 'string') {
		return type === 'null' ? schema : { ...schema, type: [type, 'null'] }
	}
	if (Array.isArray(type)) {
		return type.includes('null') ? schema : { ...schema, type: [...type, 'null'] }
	}
	// No `type` to widen — a `$ref`, an `anyOf`, an unconstrained node.
	// `anyOf` is the only form that can carry the alternative, and adding
	// one where none existed would change the shape more than it fixes.
	if (Array.isArray(schema.anyOf)) {
		const arms = schema.anyOf as unknown[]
		const hasNull = arms.some((arm) => isSchema(arm) && arm.type === 'null')
		return hasNull ? schema : { ...schema, anyOf: [...arms, { type: 'null' }] }
	}
	return schema
}

/**
 * Rewrite a JSON Schema for strict decoding. Pure: the input is not
 * touched, which matters because tool schemas are rendered once and
 * cached, frozen, for the life of the process.
 */
export function toStrictSchema(schema: Schema): Schema {
	if (!isSchema(schema)) return schema

	const out: Schema = { ...schema }

	if (Array.isArray(out.anyOf)) {
		out.anyOf = (out.anyOf as unknown[]).map((arm) => (isSchema(arm) ? toStrictSchema(arm) : arm))
	}
	if (Array.isArray(out.allOf)) {
		out.allOf = (out.allOf as unknown[]).map((arm) => (isSchema(arm) ? toStrictSchema(arm) : arm))
	}
	if (isSchema(out.items)) out.items = toStrictSchema(out.items)
	for (const key of ['$defs', 'definitions'] as const) {
		if (isSchema(out[key])) {
			out[key] = Object.fromEntries(
				Object.entries(out[key] as Schema).map(([name, value]) => [
					name,
					isSchema(value) ? toStrictSchema(value) : value,
				]),
			)
		}
	}

	if (out.type !== 'object' || !isSchema(out.properties)) return out

	const properties = out.properties as Schema
	const wasRequired = new Set(Array.isArray(out.required) ? (out.required as string[]) : [])
	const names = Object.keys(properties)

	out.properties = Object.fromEntries(
		names.map((name) => {
			const value = isSchema(properties[name])
				? toStrictSchema(properties[name] as Schema)
				: properties[name]
			// A property that was optional keeps that meaning by accepting
			// null — otherwise making it required would silently demand a
			// value the tool never needed.
			return [name, wasRequired.has(name) || !isSchema(value) ? value : nullable(value)]
		}),
	)
	out.required = names
	out.additionalProperties = false

	return out
}
