/**
 * The small part of JSON Schema the query answers use (type, enum, const, properties, required,
 * additionalProperties, items, bounds, pattern, anyOf, oneOf). Written here because the host takes no
 * dependency for it; a keyword outside this list is ignored, never trusted to have been checked.
 */
export function schemaProblems(schema: unknown, value: unknown, path = '$'): string[] {
	if (schema === true || schema === undefined) return []
	if (schema === false) return [`${path}: not allowed`]
	if (!schema || typeof schema !== 'object') return []
	const s = schema as Record<string, unknown>
	const out: string[] = []
	const typeOf = (v: unknown): string =>
		v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v
	if (s.type !== undefined) {
		const want = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string]
		const got = typeOf(value)
		if (!want.some((t) => t === got || (t === 'number' && got === 'integer')))
			return [`${path}: expected ${want.join(' or ')}, got ${got}`]
	}
	if (
		s.enum !== undefined &&
		!(s.enum as unknown[]).some((e) => JSON.stringify(e) === JSON.stringify(value))
	)
		out.push(`${path}: not one of the allowed values`)
	if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(value))
		out.push(`${path}: must be ${JSON.stringify(s.const)}`)
	if (typeof value === 'string') {
		if (typeof s.minLength === 'number' && value.length < s.minLength)
			out.push(`${path}: too short`)
		if (typeof s.maxLength === 'number' && value.length > s.maxLength) out.push(`${path}: too long`)
		if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(value))
			out.push(`${path}: does not match the pattern`)
	}
	if (typeof value === 'number') {
		if (typeof s.minimum === 'number' && value < s.minimum) out.push(`${path}: below the minimum`)
		if (typeof s.maximum === 'number' && value > s.maximum) out.push(`${path}: above the maximum`)
	}
	if (Array.isArray(value)) {
		if (typeof s.minItems === 'number' && value.length < s.minItems)
			out.push(`${path}: too few items`)
		if (typeof s.maxItems === 'number' && value.length > s.maxItems)
			out.push(`${path}: too many items`)
		if (s.items !== undefined)
			value.forEach((v, i) => out.push(...schemaProblems(s.items, v, `${path}[${i}]`)))
	}
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const o = value as Record<string, unknown>
		const props = (s.properties ?? {}) as Record<string, unknown>
		for (const r of (s.required ?? []) as string[])
			if (!(r in o)) out.push(`${path}.${r}: is required`)
		for (const k of Object.keys(o)) {
			if (k in props) out.push(...schemaProblems(props[k], o[k], `${path}.${k}`))
			else if (s.additionalProperties === false) out.push(`${path}.${k}: is not allowed`)
			else if (s.additionalProperties && typeof s.additionalProperties === 'object')
				out.push(...schemaProblems(s.additionalProperties, o[k], `${path}.${k}`))
		}
	}
	if (
		Array.isArray(s.anyOf) &&
		!s.anyOf.some((sub) => schemaProblems(sub, value, path).length === 0)
	)
		out.push(`${path}: matches none of the allowed shapes`)
	if (
		Array.isArray(s.oneOf) &&
		s.oneOf.filter((sub) => schemaProblems(sub, value, path).length === 0).length !== 1
	)
		out.push(`${path}: must match exactly one allowed shape`)
	return out
}
