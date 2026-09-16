import { MCP_PARAM_HEADER_PREFIX } from '../../constants/mcp/index.js'

/**
 * The extension property a server writes into a tool parameter's schema to
 * ask that the parameter's value be mirrored into an HTTP request header.
 *
 * Its value is the NAME PORTION of `Mcp-Param-{name}`, so an annotation
 * reading `"Region"` produces `Mcp-Param-Region`. The point of mirroring is
 * that a load balancer or a policy proxy can route and authorise a tool call
 * without parsing JSON-RPC — which is also why a malformed annotation is not
 * a cosmetic problem: a value carrying a line feed would end the field and
 * let a server's own tool definition inject a header namzu never wrote.
 */
const X_MCP_HEADER = 'x-mcp-header'

/**
 * HTTP field-name token syntax — RFC 9110 §5.1 `1*tchar`.
 *
 * Non-emptiness (`+`), the absence of CR, LF and every other control
 * character, and the absence of spaces and separators all fall out of this
 * one expression. They are still checked separately below, in the order the
 * spec lists them, so a refusal names the constraint that was actually
 * broken rather than the most general one that happens to cover it.
 */
const FIELD_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** The JSON Schema keywords whose value is a MAP of schemas, not a schema. */
const SCHEMA_MAP_KEYWORDS = new Set([
	'properties',
	'patternProperties',
	'$defs',
	'definitions',
	'dependentSchemas',
])

/**
 * Keywords holding INSTANCE data rather than sub-schemas.
 *
 * Never descended into. A `default` of `{ "x-mcp-header": "X" }` is a
 * perfectly ordinary example value for an object-typed parameter, and
 * reading it as an annotation would refuse a tool over a string that was
 * never a schema at all.
 */
const INSTANCE_VALUE_KEYWORDS = new Set(['default', 'examples', 'example', 'const', 'enum'])

/** The parameter types a value may be mirrored from. `number` is excluded. */
const MIRRORABLE_TYPES = new Set(['string', 'boolean', 'integer'])

/**
 * One validated `x-mcp-header` annotation: which header to write, which
 * argument to read it from, and how to spell that argument.
 *
 * `path` is the exact chain of `properties` keys leading to the annotated
 * property, which is also the path into a call's `arguments` object. It is
 * produced only by {@link validateMcpHeaderAnnotations}, so a binding cannot
 * exist for a property that was not statically reachable.
 */
export interface McpParamHeaderBinding {
	/** The full field name, prefix included — `Mcp-Param-Region`. */
	readonly header: string
	/** The chain of `properties` keys, read against the call's `arguments`. */
	readonly path: readonly string[]
	readonly type: 'string' | 'boolean' | 'integer'
}

/**
 * Whether a tool definition may be exposed, and what it asked to mirror.
 *
 * A verdict about the WHOLE tool, not about one annotation: the spec makes a
 * single bad annotation invalidate the tool definition, because a client
 * that mirrored the rest would send a request the server then rejects for
 * headers it cannot explain.
 */
export type McpHeaderAnnotationVerdict =
	| { readonly ok: true; readonly bindings: readonly McpParamHeaderBinding[] }
	| { readonly ok: false; readonly reason: string }

const NO_BINDINGS: McpHeaderAnnotationVerdict = { ok: true, bindings: [] }

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One annotation found anywhere in a schema, and where it was found. */
interface FoundAnnotation {
	readonly value: unknown
	/** A dotted path through the raw schema, for a refusal a person reads. */
	readonly where: string
	/** The `properties` chain, or `undefined` when it is not reachable by one. */
	readonly path: readonly string[] | undefined
	/** The `type` declared beside the annotation. */
	readonly declaredType: unknown
}

/**
 * Every property reachable from the root through `properties` keys ALONE,
 * mapped to its path.
 *
 * This is the whole of the static-reachability rule, and writing it as its
 * own walk is deliberate. The tempting implementation — resolve `$ref`s and
 * flatten `allOf` first, then walk the result — accepts exactly what the
 * spec forbids: a property reached through a `$ref` looks like an ordinary
 * `properties` child once the reference has been followed. This walk never
 * follows one, so a `$ref`-reached annotation simply is not in this map.
 */
function reachableByProperties(root: Record<string, unknown>): Map<object, string[]> {
	const reachable = new Map<object, string[]>()
	// A schema is JSON and so is usually a tree, but nothing stops a caller
	// building one with a shared (or cyclic) node in it, and this walk is
	// depth-first.
	const seen = new Set<object>([root])

	const walk = (node: Record<string, unknown>, path: readonly string[]): void => {
		const properties = node.properties
		if (!isPlainObject(properties)) return
		for (const [key, child] of Object.entries(properties)) {
			if (!isPlainObject(child) || seen.has(child)) continue
			seen.add(child)
			const childPath = [...path, key]
			reachable.set(child, childPath)
			walk(child, childPath)
		}
	}

	walk(root, [])
	return reachable
}

/**
 * Every `x-mcp-header` in the schema, wherever it sits.
 *
 * Deliberately a whole-schema scan rather than a scan of the reachable
 * properties: an annotation under `items`, inside a `oneOf` branch or in
 * `$defs` is not something to ignore, it is something that invalidates the
 * tool. Finding only the reachable ones would silently admit exactly the
 * definitions the spec says to refuse.
 *
 * The walk knows which keywords hold a MAP of schemas so that a parameter
 * legitimately NAMED `x-mcp-header` is not mistaken for an annotation on the
 * map that holds it, and refuses to descend into keywords holding instance
 * data. Everything else is descended into generically, because a vendor
 * keyword can nest a schema and an annotation buried in one is still
 * unreachable and still invalid.
 */
function annotationsIn(root: Record<string, unknown>): FoundAnnotation[] {
	const reachable = reachableByProperties(root)
	const found: FoundAnnotation[] = []
	const seen = new Set<object>()

	const visit = (node: unknown, where: string): void => {
		if (Array.isArray(node)) {
			node.forEach((item, index) => visit(item, `${where}[${index}]`))
			return
		}
		if (!isPlainObject(node) || seen.has(node)) return
		seen.add(node)

		if (Object.hasOwn(node, X_MCP_HEADER)) {
			found.push({
				value: node[X_MCP_HEADER],
				where: where === '' ? 'the schema root' : where,
				path: reachable.get(node),
				declaredType: node.type,
			})
		}

		for (const [key, child] of Object.entries(node)) {
			if (key === X_MCP_HEADER || INSTANCE_VALUE_KEYWORDS.has(key)) continue
			const childWhere = where === '' ? key : `${where}.${key}`
			if (SCHEMA_MAP_KEYWORDS.has(key)) {
				if (!isPlainObject(child)) continue
				for (const [name, schema] of Object.entries(child)) visit(schema, `${childWhere}.${name}`)
				continue
			}
			visit(child, childWhere)
		}
	}

	visit(root, '')
	return found
}

/** A value quoted into a refusal without carrying its control bytes along. */
function quoted(value: unknown): string {
	return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

function describeType(declared: unknown): string {
	if (declared === undefined) return 'a parameter with no declared `type`'
	if (typeof declared !== 'string') return `a parameter whose \`type\` is ${quoted(declared)}`
	return `a \`${declared}\` parameter`
}

function refuse(reason: string): McpHeaderAnnotationVerdict {
	return { ok: false, reason }
}

/**
 * Decide whether a tool may be exposed, and collect what it asked to mirror.
 *
 * The six constraints, in the spec's own order: non-empty; HTTP field-name
 * token syntax; no control characters; case-insensitively unique across the
 * whole `inputSchema`; applied only to `string`, `boolean` or `integer`
 * (never `number`); and statically reachable through a chain of `properties`
 * keys alone.
 *
 * Returns a REASON rather than throwing, because the caller's job is to drop
 * one tool and keep the rest: a listing where one definition is malformed
 * must still deliver the others, and an exception here would take the whole
 * listing down with it.
 */
export function validateMcpHeaderAnnotations(inputSchema: unknown): McpHeaderAnnotationVerdict {
	if (!isPlainObject(inputSchema)) return NO_BINDINGS

	const found = annotationsIn(inputSchema)
	if (found.length === 0) return NO_BINDINGS

	const bindings: McpParamHeaderBinding[] = []
	/** Lowercased name to the spelling that claimed it first. */
	const claimed = new Map<string, string>()

	for (const annotation of found) {
		const at = `at ${annotation.where}`
		const name = annotation.value

		if (typeof name !== 'string') {
			return refuse(`\`x-mcp-header\` ${at} is ${quoted(name)}, which is not a string`)
		}
		if (name.length === 0) {
			return refuse(`\`x-mcp-header\` ${at} is empty`)
		}
		if (/[\r\n]/.test(name)) {
			return refuse(
				`\`x-mcp-header\` ${quoted(name)} ${at} contains a carriage return or line feed`,
			)
		}
		if (!FIELD_NAME_TOKEN.test(name)) {
			return refuse(
				`\`x-mcp-header\` ${quoted(name)} ${at} is not HTTP field-name token syntax (RFC 9110 1*tchar)`,
			)
		}

		const first = claimed.get(name.toLowerCase())
		if (first !== undefined) {
			return refuse(
				`\`x-mcp-header\` ${quoted(name)} ${at} repeats ${quoted(first)}; header names are compared without regard to case`,
			)
		}
		claimed.set(name.toLowerCase(), name)

		if (annotation.path === undefined) {
			return refuse(
				`\`x-mcp-header\` ${quoted(name)} ${at} is not statically reachable: the chain from the schema root must consist solely of \`properties\` keys`,
			)
		}

		const declared = annotation.declaredType
		if (typeof declared !== 'string' || !MIRRORABLE_TYPES.has(declared)) {
			return refuse(
				`\`x-mcp-header\` ${quoted(name)} ${at} annotates ${describeType(declared)}; only \`string\`, \`boolean\` and \`integer\` may be mirrored, and \`number\` is excluded`,
			)
		}

		bindings.push({
			header: `${MCP_PARAM_HEADER_PREFIX}${name}`,
			path: annotation.path,
			type: declared as McpParamHeaderBinding['type'],
		})
	}

	return { ok: true, bindings }
}

function readPath(root: unknown, path: readonly string[]): unknown {
	let cursor: unknown = root
	for (const key of path) {
		if (!isPlainObject(cursor)) return undefined
		cursor = cursor[key]
	}
	return cursor
}

/**
 * How one argument value is spelled in a header field, or `undefined` when
 * it is not sent at all.
 *
 * Four reasons a header is omitted, and only the first two are ordinary: the
 * argument is absent, or it is `null` — both of which the spec says to omit
 * rather than send empty. The other two are a server contradicting its own
 * schema (a value whose runtime type is not the declared one) and an integer
 * outside the range the spec bounds these to, ±(2^53−1) — exactly
 * JavaScript's safe-integer range, which is the range in which the number
 * this client parsed is still the number the server sent. Sending either
 * would put a value on the wire that disagrees with the body it mirrors,
 * which is the one thing a conforming server rejects outright.
 */
function headerValue(type: McpParamHeaderBinding['type'], value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined
	if (type === 'string') return typeof value === 'string' ? value : undefined
	if (type === 'boolean') return typeof value === 'boolean' ? String(value) : undefined
	return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : undefined
}

/**
 * The `Mcp-Param-*` field values for one call's arguments, unencoded.
 *
 * Returns the values as the BODY carries them; wrapping a value that cannot
 * be written into a header field verbatim is the envelope's job, so the
 * sentinel rule lives in one place for `Mcp-Name` and `Mcp-Param-*` alike
 * rather than being reimplemented here.
 */
export function mcpParamHeaderValues(
	bindings: readonly McpParamHeaderBinding[],
	args: unknown,
): Record<string, string> {
	const headers: Record<string, string> = {}
	for (const binding of bindings) {
		const written = headerValue(binding.type, readPath(args, binding.path))
		if (written !== undefined) headers[binding.header] = written
	}
	return headers
}
