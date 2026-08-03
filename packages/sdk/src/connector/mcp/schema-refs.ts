/**
 * Resolve `$ref` pointers in a remote tool's input schema before it is
 * converted.
 *
 * A `$ref` reached the converter's `default:` branch and became "anything":
 * no type, no shape, nothing for the model to work from. And because the
 * resulting node is inherently optional, a `$ref`'d field the server listed
 * as required stopped being enforced too — an empty payload validated
 * clean and was forwarded to the server instead of being rejected with the
 * "Required: <field>" hint the executor already knows how to build.
 *
 * That is not an exotic shape. `$defs` + `$ref` is what several widely used
 * schema generators emit by default for a nested object, so a server that
 * did everything right presented its main argument to the model as `{}`.
 */

/** How deep to follow a schema before giving up. */
export const MAX_SCHEMA_DEPTH = 64

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Decode one JSON Pointer token (RFC 6901): `~1` is `/`, `~0` is `~`. */
function decodeToken(token: string): string {
	return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

/**
 * Follow a local pointer (`#/$defs/Thing`) from the document root.
 *
 * Only same-document pointers are resolvable. A `$ref` to another file or
 * a URL would need a fetch, which is not something a schema conversion may
 * do — those are left alone and fall through to the permissive branch, the
 * same as before.
 */
function resolvePointer(root: JsonObject, ref: string): unknown {
	if (ref === '#') return root
	if (!ref.startsWith('#/')) return undefined

	let current: unknown = root
	for (const raw of ref.slice(2).split('/')) {
		const token = decodeToken(raw)
		if (Array.isArray(current)) {
			const index = Number(token)
			if (!Number.isInteger(index)) return undefined
			current = current[index]
			continue
		}
		if (!isObject(current)) return undefined
		current = current[token]
	}
	return current
}

interface InlineState {
	readonly root: JsonObject
	/** Pointers currently being expanded on THIS path — a cycle guard. */
	readonly active: Set<string>
	readonly depth: number
}

function walk(node: unknown, state: InlineState): unknown {
	if (Array.isArray(node)) {
		return node.map((item) => walk(item, state))
	}
	if (!isObject(node)) return node
	if (state.depth >= MAX_SCHEMA_DEPTH) return node

	const ref = node.$ref
	if (typeof ref === 'string') {
		return expandRef(node, ref, state)
	}

	const out: JsonObject = {}
	for (const [key, value] of Object.entries(node)) {
		// `$defs` / `definitions` are a dictionary of targets, not part of
		// the shape. Once every pointer is inlined they describe nothing, and
		// leaving them in would re-render as dead weight in the schema the
		// model is shown.
		if (key === '$defs' || key === 'definitions') continue
		out[key] = walk(value, { ...state, depth: state.depth + 1 })
	}
	return out
}

function expandRef(node: JsonObject, ref: string, state: InlineState): unknown {
	const { $ref: _ref, ...siblings } = node

	if (state.active.has(ref)) {
		// A self-referential schema (a tree node whose children are the same
		// node) cannot be expanded into a finite tree. Stopping here yields
		// the permissive node the whole conversion used to produce — but for
		// one branch of one recursive type, not for every `$ref` in the
		// document.
		return { ...siblings }
	}

	const target = resolvePointer(state.root, ref)
	if (!isObject(target)) {
		// A dangling or non-local pointer. The server's schema is wrong or
		// unreachable; that is its problem to report, and guessing a shape
		// here would be worse than admitting we do not know one.
		return { ...siblings }
	}

	state.active.add(ref)
	const expanded = walk(target, { ...state, depth: state.depth + 1 })
	state.active.delete(ref)

	// Sibling keywords alongside `$ref` are legal since draft 2019-09 and are
	// commonly a `description` on the reference site. They win: they are the
	// more specific statement about this position.
	return isObject(expanded) ? { ...expanded, ...siblings } : expanded
}

/**
 * Return the schema with every resolvable local `$ref` replaced by its
 * target. Non-local and dangling pointers, and the second visit to a
 * recursive one, degrade to whatever sibling keywords were present.
 */
export function inlineSchemaRefs(schema: JsonObject): JsonObject {
	return walk(schema, { root: schema, active: new Set(), depth: 0 }) as JsonObject
}
