/**
 * The syntax tree → index rows.
 *
 * One iterative pass over an ESTree, writing into a {@link RowSink}. Iterative
 * because a minified bundle nests deeper than the call stack allows and a
 * recursive walker dies on exactly the files this package exists for.
 *
 * Every offset is the node's own `start` / `end`, which `oxc-parser` reports as
 * UTF-16 offsets into the string it was given — the unit the rest of the
 * package uses, so nothing here converts.
 */

// The ESTree is untyped on purpose: the walker reads a dozen node shapes and
// dispatches on `type`, and a precise union would be the parser's whole type
// package restated for no gain.
// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes are read by shape
type Node = Record<string, any>

export interface FunctionRow {
	readonly id: number
	readonly parentId: number | null
	readonly kind: string
	readonly name: string | null
	/**
	 * The name qualified by what holds it: `Svc.init` for a method of `Svc`,
	 * `obj.run` for a method of an object assigned to `obj`. `null` when it is
	 * the same as `name`.
	 */
	readonly qname: string | null
	readonly start: number
	readonly end: number
}

/** A class, so a position in its body but outside every method can be described. */
export interface ClassRow {
	readonly name: string | null
	readonly start: number
	readonly end: number
}

export interface StringRow {
	readonly fnId: number | null
	readonly start: number
	readonly end: number
	readonly kind: 'string' | 'template' | 'key'
	readonly value: string
	/** The literal's real length when `value` keeps only its two ends; 0 when it is whole. */
	readonly cut: number
}

export interface CallRow {
	readonly fnId: number | null
	readonly start: number
	readonly end: number
	readonly callee: string
	/**
	 * `call-via` is `f.call(…)`, `f.apply(…)` or `f.bind(…)`, recorded against
	 * `f`; `tagged` is a tagged template, recorded against its tag.
	 */
	readonly kind: 'call' | 'new' | 'call-via' | 'tagged'
	readonly nargs: number
	/** For `this.m(…)`: the class (or object) whose `this` that is, when known. */
	readonly owner: string | null
}

export interface ImportRow {
	readonly kind: 'static' | 'type' | 'require' | 'dynamic'
	readonly source: string
	readonly names: string
	readonly start: number
}

export interface ExportRow {
	/**
	 * `type`: a type-only export. `commonjs`: `module.exports` or `exports.x`.
	 * `assign`: `export =`.
	 */
	readonly kind: 'named' | 'default' | 'reexport' | 'star' | 'type' | 'commonjs' | 'assign'
	readonly name: string
	readonly source: string | null
	readonly start: number
}

/** Everything one file contributes. Plain data, so it crosses a process boundary. */
export interface RowsPayload {
	readonly functions: readonly FunctionRow[]
	readonly classes: readonly ClassRow[]
	readonly strings: readonly StringRow[]
	readonly calls: readonly CallRow[]
	readonly imports: readonly ImportRow[]
	readonly exports: readonly ExportRow[]
}

export const EMPTY_ROWS: RowsPayload = {
	functions: [],
	classes: [],
	strings: [],
	calls: [],
	imports: [],
	exports: [],
}

export class RowSink implements RowsPayload {
	readonly functions: FunctionRow[] = []
	readonly classes: ClassRow[] = []
	readonly strings: StringRow[] = []
	readonly calls: CallRow[] = []
	readonly imports: ImportRow[] = []
	readonly exports: ExportRow[] = []
	constructor(private nextId: number) {}
	/** The next function id this sink will hand out. */
	get next(): number {
		return this.nextId
	}
	fn(row: Omit<FunctionRow, 'id'>): number {
		const id = this.nextId++
		this.functions.push({ id, ...row })
		return id
	}
}

/**
 * How much of each end of a long literal is kept. A literal of up to twice this
 * is stored whole; a longer one keeps its first and last this-many characters,
 * so a query that names the start or the end of an embedded bundle or prompt
 * still finds it, and the rows say it was cut.
 */
export const MAX_LITERAL_CHARS = 4096
/** Between the two ends of a cut literal. A control character: not text anyone searches for. */
export const CUT_MARK = '\u0001\u2026\u0001'

function cap(value: string): { value: string; cut: number } {
	if (value.length <= MAX_LITERAL_CHARS * 2) return { value, cut: 0 }
	let head = MAX_LITERAL_CHARS
	// Never end on half of a surrogate pair: the stored text must be valid.
	const last = value.charCodeAt(head - 1)
	if (last >= 0xd800 && last <= 0xdbff) head--
	let tail = value.length - MAX_LITERAL_CHARS
	const first = value.charCodeAt(tail)
	if (first >= 0xdc00 && first <= 0xdfff) tail++
	return { value: value.slice(0, head) + CUT_MARK + value.slice(tail), cut: value.length }
}

/** Keys that hold types or other things with no runtime strings or calls in them. */
const SKIP_KEYS = new Set([
	'typeAnnotation',
	'returnType',
	'typeParameters',
	'typeArguments',
	'superTypeArguments',
	'superTypeParameters',
	'implements',
	'comments',
	'tokens',
	'errors',
])

/** Whole subtrees that are types: a string in one is not a runtime value. */
const SKIP_TYPES = new Set([
	'TSInterfaceDeclaration',
	'TSTypeAliasDeclaration',
	'TSTypeAnnotation',
	'TSTypeParameterDeclaration',
	'TSTypeParameterInstantiation',
	'TSLiteralType',
	'TSImportType',
	'TSIndexSignature',
	'TSTypeQuery',
	'TSDeclareFunction',
	'TSEmptyBodyFunctionExpression',
])

const FUNCTION_TYPES = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression',
])

/**
 * The text a callee is matched by.
 *
 * The shapes a bundler or compiler wraps a plain call in are unwrapped, or the
 * call would be invisible to every caller search: `(0, ns.fn)()` is the
 * interop form of `ns.fn()`, and `obj['name']()` is `obj.name()`.
 */
function calleeText(node: Node | null | undefined): string {
	if (!node) return '?'
	switch (node.type) {
		case 'Identifier':
			return node.name
		case 'Super':
			return 'super'
		case 'Import':
			return 'import'
		case 'ThisExpression':
			return 'this'
		case 'MemberExpression': {
			const object = calleeText(node.object)
			if (!node.computed && node.property) {
				return `${object}.${node.property.name ?? node.property.value ?? '?'}`
			}
			const key = node.property
			if (node.computed && key?.type === 'Literal' && typeof key.value === 'string') {
				return `${object}.${key.value}`
			}
			return `${object}[]`
		}
		case 'SequenceExpression': {
			// `(0, fn)(…)`: the value of a comma expression is its last operand.
			const list: Node[] = node.expressions ?? []
			return calleeText(list[list.length - 1])
		}
		case 'ChainExpression':
		case 'ParenthesizedExpression':
		case 'TSNonNullExpression':
		case 'TSAsExpression':
		case 'TSSatisfiesExpression':
		case 'TSTypeAssertion':
			return calleeText(node.expression)
		case 'FunctionExpression':
		case 'ArrowFunctionExpression':
			return '(iife)'
		case 'CallExpression':
			return `${calleeText(node.callee)}()`
		default:
			return '?'
	}
}

const CALL_VIA = new Set(['call', 'apply', 'bind'])

/** `f` for `f.call(…)`, `f.apply(…)` and `f.bind(…)`; otherwise `undefined`. */
function callViaTarget(callee: Node | null | undefined): string | undefined {
	let node = callee
	while (
		node &&
		(node.type === 'ChainExpression' ||
			node.type === 'ParenthesizedExpression' ||
			node.type === 'TSNonNullExpression')
	)
		node = node.expression
	if (node?.type !== 'MemberExpression') return undefined
	const key = node.property
	const name = node.computed
		? key?.type === 'Literal' && typeof key.value === 'string'
			? key.value
			: undefined
		: key?.name
	if (name === undefined || !CALL_VIA.has(name)) return undefined
	const target = calleeText(node.object)
	return target === '?' ? undefined : target
}

function keyName(key: Node | null | undefined, computed: boolean): string | null {
	if (!key || computed) return null
	// `#private`: the identifier arrives without its sigil.
	if (key.type === 'PrivateIdentifier' && typeof key.name === 'string') return `#${key.name}`
	if (typeof key.name === 'string') return key.name
	if (typeof key.value === 'string') return key.value
	return null
}

/** A function's name: its own, else the thing it is assigned to. */
function inferName(node: Node, parent: Node | null): string | null {
	if (node.id?.name) return node.id.name
	if (!parent) return null
	switch (parent.type) {
		case 'VariableDeclarator':
			return parent.id?.type === 'Identifier' ? parent.id.name : null
		case 'AssignmentExpression':
			return parent.left?.type === 'Identifier' ? parent.left.name : calleeText(parent.left)
		case 'Property':
		case 'PropertyDefinition':
		case 'AccessorProperty':
		case 'MethodDefinition':
			return keyName(parent.key, parent.computed)
		case 'AssignmentPattern':
			return parent.left?.type === 'Identifier' ? parent.left.name : null
		default:
			return null
	}
}

/**
 * The node that OWNS a function's range.
 *
 * In ESTree a method is a `MethodDefinition` whose `value` is a
 * `FunctionExpression` that starts at the parameter list, so its own range
 * misses the name, `static`, `async` and `get`. A reader asking for "the
 * function" wants the whole method, and the parent has it. Same for an object
 * method, getter or setter, which are `Property` nodes.
 */
function rangeOwner(node: Node, parent: Node | null): { owner: Node; kind: string } {
	if (parent?.type === 'MethodDefinition' && parent.value === node) {
		const kind =
			parent.kind === 'constructor'
				? 'constructor'
				: parent.kind === 'get'
					? 'getter'
					: parent.kind === 'set'
						? 'setter'
						: 'method'
		return { owner: parent, kind }
	}
	if (
		parent?.type === 'Property' &&
		parent.value === node &&
		(parent.method === true || parent.kind === 'get' || parent.kind === 'set')
	) {
		const kind = parent.kind === 'get' ? 'getter' : parent.kind === 'set' ? 'setter' : 'method'
		return { owner: parent, kind }
	}
	const kind =
		node.type === 'FunctionDeclaration'
			? 'declaration'
			: node.type === 'ArrowFunctionExpression'
				? 'arrow'
				: 'expression'
	return { owner: node, kind }
}

function specifierName(node: Node | null | undefined): string {
	if (!node) return '?'
	return typeof node.name === 'string' ? node.name : String(node.value ?? '?')
}

function importNames(specifiers: readonly Node[]): string {
	return specifiers
		.map((s) => {
			if (s.type === 'ImportDefaultSpecifier') return `default as ${specifierName(s.local)}`
			if (s.type === 'ImportNamespaceSpecifier') return `* as ${specifierName(s.local)}`
			const imported = specifierName(s.imported)
			const local = specifierName(s.local)
			return imported === local ? imported : `${imported} as ${local}`
		})
		.join(',')
}

/** Every name a binding pattern introduces: `{ a, b: [c, ...d] }` is a, c, d. */
function patternNames(pattern: Node | null | undefined, out: string[] = []): string[] {
	if (!pattern) return out
	switch (pattern.type) {
		case 'Identifier':
			out.push(pattern.name)
			break
		case 'ObjectPattern':
			for (const p of (pattern.properties ?? []) as Node[]) {
				patternNames(p.type === 'RestElement' ? p.argument : p.value, out)
			}
			break
		case 'ArrayPattern':
			for (const e of (pattern.elements ?? []) as Array<Node | null>) patternNames(e, out)
			break
		case 'RestElement':
			patternNames(pattern.argument, out)
			break
		case 'AssignmentPattern':
			patternNames(pattern.left, out)
			break
	}
	return out
}

function declaredNames(declaration: Node): string[] {
	switch (declaration.type) {
		case 'VariableDeclaration':
			return (declaration.declarations as Node[]).flatMap((d) => patternNames(d.id))
		default:
			return declaration.id?.name ? [declaration.id.name as string] : []
	}
}

/** The names a `const … = require('x')` binds, in the form `import` names use. */
function requireNames(parent: Node | null, call: Node): string {
	if (!parent) return ''
	if (parent.type === 'VariableDeclarator' && parent.init === call) {
		const id = parent.id
		if (id?.type === 'Identifier') return `* as ${id.name}`
		if (id?.type === 'ObjectPattern') {
			return ((id.properties ?? []) as Node[])
				.map((p) => {
					if (p.type === 'RestElement') return `...${patternNames(p.argument).join('')}`
					const imported = p.key?.name ?? p.key?.value
					const local = patternNames(p.value).join('')
					if (typeof imported !== 'string') return local
					return imported === local || local === '' ? imported : `${imported} as ${local}`
				})
				.filter((n) => n !== '')
				.join(',')
		}
		return ''
	}
	// `require('x').name`
	if (parent.type === 'MemberExpression' && parent.object === call && !parent.computed) {
		return typeof parent.property?.name === 'string' ? parent.property.name : ''
	}
	return ''
}

/** `module.exports` as written. */
function isModuleExports(node: Node | null | undefined): boolean {
	return (
		node?.type === 'MemberExpression' &&
		!node.computed &&
		node.object?.type === 'Identifier' &&
		node.object.name === 'module' &&
		node.property?.name === 'exports'
	)
}

/** The CommonJS export a left-hand side names: `module.exports` itself, or `exports.x` / `module.exports.x`. */
function commonJsTarget(
	left: Node | null | undefined,
): { whole: boolean; name?: string } | undefined {
	if (!left || left.type !== 'MemberExpression') return undefined
	if (isModuleExports(left)) return { whole: true }
	const object = left.object
	const viaExports =
		(object?.type === 'Identifier' && object.name === 'exports') || isModuleExports(object)
	if (!viaExports) return undefined
	const key = left.property
	const name = left.computed
		? key?.type === 'Literal' && typeof key.value === 'string'
			? key.value
			: undefined
		: key?.name
	return name === undefined ? undefined : { whole: false, name }
}

interface Frame {
	node: Node
	parent: Node | null
	fnId: number | null
	/**
	 * What a member written directly under this node is qualified by: the class
	 * for a method, the object for an object-literal method. `null` elsewhere,
	 * so a function nested in a method is never taken for a member.
	 */
	container: string | null
	/** The class (or object) the lexical `this` belongs to; arrows pass it through. */
	thisOwner: string | null
	/** The name a class or object literal directly below this node would take. */
	hint: string | null
}

const PASS_HINT = new Set([
	'ChainExpression',
	'ParenthesizedExpression',
	'TSNonNullExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSTypeAssertion',
])
const PASS_CONTAINER = new Set([
	'ClassBody',
	'MethodDefinition',
	'PropertyDefinition',
	'AccessorProperty',
	'StaticBlock',
])

/** The name a left-hand side gives what is assigned to it. */
function targetName(left: Node | null | undefined): string | null {
	if (!left) return null
	if (left.type === 'Identifier') return left.name
	const text = calleeText(left)
	return text === '?' || text.includes('[]') || text.includes('()') ? null : text
}

/**
 * Walk `program`, adding rows to `sink`. `fnId` of the top level is `null`.
 */
export function indexProgram(program: Node, sink: RowSink): void {
	const stack: Frame[] = [
		{ node: program, parent: null, fnId: null, container: null, thisOwner: null, hint: null },
	]
	while (stack.length > 0) {
		const frame = stack.pop() as Frame
		const { node, parent } = frame
		let fnId = frame.fnId
		const type: string = node.type
		if (SKIP_TYPES.has(type)) continue

		let childContainer: string | null = null
		let childOwner = frame.thisOwner
		let childHint: string | null = null

		if (FUNCTION_TYPES.has(type)) {
			const { owner, kind } = rangeOwner(node, parent)
			const bare =
				owner === node ? inferName(node, parent) : (keyName(owner.key, owner.computed) ?? null)
			// A member: a method, accessor, class field or object property whose
			// value is this function, written inside a class or an object literal.
			const member =
				frame.container !== null &&
				(owner !== node ||
					(parent !== null &&
						(parent.type === 'Property' ||
							parent.type === 'PropertyDefinition' ||
							parent.type === 'AccessorProperty') &&
						parent.value === node))
			const qname = member && bare !== null ? `${frame.container}.${bare}` : null
			fnId = sink.fn({
				parentId: frame.fnId,
				kind,
				name: bare,
				qname,
				start: owner.start,
				end: owner.end,
			})
			// A function has its own `this` unless it is an arrow; a member's is
			// the class or object that holds it.
			if (type !== 'ArrowFunctionExpression') childOwner = member ? frame.container : null
		} else if (type === 'ClassDeclaration' || type === 'ClassExpression') {
			const name: string | null = node.id?.name ?? frame.hint
			sink.classes.push({ name, start: node.start, end: node.end })
			childContainer = name
			childOwner = name
		} else if (type === 'ObjectExpression') {
			childContainer = frame.hint
		} else if (PASS_CONTAINER.has(type)) {
			childContainer = frame.container
		} else if (type === 'Property') {
			childContainer = frame.container
			const key = keyName(node.key, node.computed)
			childHint = frame.container !== null && key !== null ? `${frame.container}.${key}` : null
		} else if (type === 'VariableDeclarator') {
			childHint = node.id?.type === 'Identifier' ? node.id.name : null
		} else if (type === 'AssignmentExpression') {
			childHint = targetName(node.left)
		} else if (type === 'ExportDefaultDeclaration') {
			childHint = 'default'
		} else if (PASS_HINT.has(type)) {
			childHint = frame.hint
		}
		if (type === 'Literal') {
			if (typeof node.value === 'string' && !isModuleSource(node, parent)) {
				const kept = cap(node.value)
				sink.strings.push({
					fnId: frame.fnId,
					start: node.start,
					end: node.end,
					kind: parent?.key === node && !parent.computed ? 'key' : 'string',
					value: kept.value,
					cut: kept.cut,
				})
			}
		} else if (type === 'TemplateElement') {
			const value: string = node.value?.cooked ?? node.value?.raw ?? ''
			if (value.length > 0) {
				const kept = cap(value)
				sink.strings.push({
					fnId: frame.fnId,
					start: node.start,
					end: node.end,
					kind: 'template',
					value: kept.value,
					cut: kept.cut,
				})
			}
		} else if (type === 'CallExpression' || type === 'NewExpression') {
			const args: Node[] = node.arguments ?? []
			const callee = calleeText(node.callee)
			const own = callee.startsWith('this.') ? frame.thisOwner : null
			sink.calls.push({
				fnId: frame.fnId,
				start: node.start,
				end: node.end,
				callee,
				kind: type === 'NewExpression' ? 'new' : 'call',
				nargs: args.length,
				owner: own,
			})
			if (type === 'CallExpression') {
				// `f.call(x)`, `f.apply(x)` and `f.bind(x)` also use `f`.
				const via = callViaTarget(node.callee)
				if (via !== undefined) {
					sink.calls.push({
						fnId: frame.fnId,
						start: node.start,
						end: node.end,
						callee: via,
						kind: 'call-via',
						nargs: args.length,
						owner: via.startsWith('this.') ? frame.thisOwner : null,
					})
				}
			}
			const first = args[0]
			if (
				type === 'CallExpression' &&
				node.callee?.type === 'Identifier' &&
				node.callee.name === 'require' &&
				first?.type === 'Literal' &&
				typeof first.value === 'string'
			) {
				sink.imports.push({
					kind: 'require',
					source: first.value,
					names: requireNames(parent, node),
					start: node.start,
				})
			}
			// `Object.defineProperty(exports, 'x', …)`
			if (
				type === 'CallExpression' &&
				callee === 'Object.defineProperty' &&
				first &&
				(first.type === 'Identifier' ? first.name === 'exports' : isModuleExports(first)) &&
				args[1]?.type === 'Literal' &&
				typeof args[1].value === 'string' &&
				args[1].value !== '__esModule'
			) {
				sink.exports.push({
					kind: 'commonjs',
					name: args[1].value,
					source: null,
					start: node.start,
				})
			}
		} else if (type === 'TaggedTemplateExpression') {
			sink.calls.push({
				fnId: frame.fnId,
				start: node.start,
				end: node.end,
				callee: calleeText(node.tag),
				kind: 'tagged',
				nargs: (node.quasi?.expressions ?? []).length,
				owner: calleeText(node.tag).startsWith('this.') ? frame.thisOwner : null,
			})
		} else if (type === 'AssignmentExpression') {
			const target = commonJsTarget(node.left)
			if (target?.whole) {
				sink.exports.push({
					kind: 'commonjs',
					name: 'module.exports',
					source: null,
					start: node.start,
				})
				if (node.right?.type === 'ObjectExpression') {
					for (const p of (node.right.properties ?? []) as Node[]) {
						const name = p.type === 'Property' ? keyName(p.key, p.computed) : null
						if (name !== null)
							sink.exports.push({ kind: 'commonjs', name, source: null, start: p.start })
					}
				}
			} else if (target?.name !== undefined && target.name !== '__esModule') {
				sink.exports.push({ kind: 'commonjs', name: target.name, source: null, start: node.start })
			}
		} else if (type === 'ImportExpression') {
			const source = node.source
			sink.calls.push({
				fnId: frame.fnId,
				start: node.start,
				end: node.end,
				callee: 'import',
				kind: 'call',
				nargs: 1,
				owner: null,
			})
			if (source?.type === 'Literal' && typeof source.value === 'string') {
				sink.imports.push({ kind: 'dynamic', source: source.value, names: '', start: node.start })
			}
		} else if (type === 'ImportDeclaration') {
			sink.imports.push({
				kind: node.importKind === 'type' ? 'type' : 'static',
				source: String(node.source?.value ?? ''),
				names: importNames(node.specifiers ?? []),
				start: node.start,
			})
		} else if (type === 'TSImportEqualsDeclaration') {
			const ref = node.moduleReference
			if (ref?.type === 'TSExternalModuleReference' && typeof ref.expression?.value === 'string') {
				sink.imports.push({
					kind: 'require',
					source: ref.expression.value,
					names: `* as ${specifierName(node.id)}`,
					start: node.start,
				})
			}
		} else if (type === 'ExportNamedDeclaration') {
			const source: string | null = node.source ? String(node.source.value) : null
			const typeOnly = node.exportKind === 'type'
			if (node.declaration) {
				const decl: Node = node.declaration
				const declaredType =
					typeOnly ||
					decl.type === 'TSTypeAliasDeclaration' ||
					decl.type === 'TSInterfaceDeclaration'
				for (const name of declaredNames(decl)) {
					sink.exports.push({
						kind: declaredType ? 'type' : 'named',
						name,
						source: null,
						start: node.start,
					})
				}
			} else {
				for (const s of (node.specifiers ?? []) as Node[]) {
					sink.exports.push({
						kind:
							typeOnly || s.exportKind === 'type' ? 'type' : source === null ? 'named' : 'reexport',
						name: specifierName(s.exported),
						source,
						start: node.start,
					})
				}
			}
		} else if (type === 'ExportAllDeclaration') {
			sink.exports.push({
				kind: 'star',
				name: node.exported ? specifierName(node.exported) : '*',
				source: String(node.source?.value ?? ''),
				start: node.start,
			})
		} else if (type === 'TSExportAssignment') {
			sink.exports.push({ kind: 'assign', name: 'export =', source: null, start: node.start })
		} else if (type === 'ExportDefaultDeclaration') {
			sink.exports.push({ kind: 'default', name: 'default', source: null, start: node.start })
		}

		// Children, pushed in reverse so they pop in source order and ids come
		// out in source order too.
		const keys = Object.keys(node)
		for (let k = keys.length - 1; k >= 0; k--) {
			const key = keys[k] as string
			if (SKIP_KEYS.has(key)) continue
			const value = node[key]
			if (value === null || typeof value !== 'object') continue
			if (Array.isArray(value)) {
				for (let i = value.length - 1; i >= 0; i--) {
					const child = value[i]
					if (child && typeof child.type === 'string')
						stack.push({
							node: child,
							parent: node,
							fnId,
							container: childContainer,
							thisOwner: childOwner,
							hint: childHint,
						})
				}
			} else if (typeof value.type === 'string') {
				stack.push({
					node: value,
					parent: node,
					fnId,
					container: childContainer,
					thisOwner: childOwner,
					hint: childHint,
				})
			}
		}
	}
}

/** The string in `import "x"` / `export … from "x"` is a module name, not a literal. */
function isModuleSource(node: Node, parent: Node | null): boolean {
	if (!parent) return false
	return (
		(parent.type === 'ImportDeclaration' ||
			parent.type === 'ExportAllDeclaration' ||
			parent.type === 'ExportNamedDeclaration') &&
		parent.source === node
	)
}
