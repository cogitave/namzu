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
	readonly start: number
	readonly end: number
}

export interface StringRow {
	readonly fnId: number | null
	readonly start: number
	readonly end: number
	readonly kind: 'string' | 'template' | 'key'
	readonly value: string
}

export interface CallRow {
	readonly fnId: number | null
	readonly start: number
	readonly end: number
	readonly callee: string
	readonly kind: 'call' | 'new'
	readonly nargs: number
}

export interface ImportRow {
	readonly kind: 'static' | 'type' | 'require' | 'dynamic'
	readonly source: string
	readonly names: string
	readonly start: number
}

export interface ExportRow {
	readonly kind: 'named' | 'default' | 'reexport' | 'star'
	readonly name: string
	readonly source: string | null
	readonly start: number
}

export class RowSink {
	readonly functions: FunctionRow[] = []
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

/** The most of a literal that is kept. Longer ones are cut, not dropped. */
export const MAX_LITERAL_CHARS = 4096

function cap(value: string): string {
	if (value.length <= MAX_LITERAL_CHARS) return value
	let end = MAX_LITERAL_CHARS
	// Never end on half of a surrogate pair: the stored text must be valid.
	const last = value.charCodeAt(end - 1)
	if (last >= 0xd800 && last <= 0xdbff) end--
	return value.slice(0, end)
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
			return `${object}[]`
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

function declaredNames(declaration: Node): string[] {
	switch (declaration.type) {
		case 'VariableDeclaration':
			return (declaration.declarations as Node[]).flatMap((d) =>
				d.id?.type === 'Identifier' ? [d.id.name as string] : [],
			)
		default:
			return declaration.id?.name ? [declaration.id.name as string] : []
	}
}

interface Frame {
	node: Node
	parent: Node | null
	fnId: number | null
}

/**
 * Walk `program`, adding rows to `sink`. `fnId` of the top level is `null`.
 */
export function indexProgram(program: Node, sink: RowSink): void {
	const stack: Frame[] = [{ node: program, parent: null, fnId: null }]
	while (stack.length > 0) {
		const frame = stack.pop() as Frame
		const { node, parent } = frame
		let fnId = frame.fnId
		const type: string = node.type
		if (SKIP_TYPES.has(type)) continue

		if (FUNCTION_TYPES.has(type)) {
			const { owner, kind } = rangeOwner(node, parent)
			fnId = sink.fn({
				parentId: frame.fnId,
				kind,
				name:
					owner === node ? inferName(node, parent) : (keyName(owner.key, owner.computed) ?? null),
				start: owner.start,
				end: owner.end,
			})
		} else if (type === 'Literal') {
			if (typeof node.value === 'string' && !isModuleSource(node, parent)) {
				sink.strings.push({
					fnId: frame.fnId,
					start: node.start,
					end: node.end,
					kind: parent?.key === node && !parent.computed ? 'key' : 'string',
					value: cap(node.value),
				})
			}
		} else if (type === 'TemplateElement') {
			const value: string = node.value?.cooked ?? node.value?.raw ?? ''
			if (value.length > 0) {
				sink.strings.push({
					fnId: frame.fnId,
					start: node.start,
					end: node.end,
					kind: 'template',
					value: cap(value),
				})
			}
		} else if (type === 'CallExpression' || type === 'NewExpression') {
			const args: Node[] = node.arguments ?? []
			sink.calls.push({
				fnId: frame.fnId,
				start: node.start,
				end: node.end,
				callee: calleeText(node.callee),
				kind: type === 'NewExpression' ? 'new' : 'call',
				nargs: args.length,
			})
			const first = args[0]
			if (
				type === 'CallExpression' &&
				node.callee?.type === 'Identifier' &&
				node.callee.name === 'require' &&
				first?.type === 'Literal' &&
				typeof first.value === 'string'
			) {
				sink.imports.push({ kind: 'require', source: first.value, names: '', start: node.start })
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
					names: specifierName(node.id),
					start: node.start,
				})
			}
		} else if (type === 'ExportNamedDeclaration') {
			const source: string | null = node.source ? String(node.source.value) : null
			if (node.declaration) {
				for (const name of declaredNames(node.declaration)) {
					sink.exports.push({ kind: 'named', name, source: null, start: node.start })
				}
			} else {
				for (const s of (node.specifiers ?? []) as Node[]) {
					sink.exports.push({
						kind: source === null ? 'named' : 'reexport',
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
		} else if (type === 'ExportDefaultDeclaration' || type === 'TSExportAssignment') {
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
						stack.push({ node: child, parent: node, fnId })
				}
			} else if (typeof value.type === 'string') {
				stack.push({ node: value, parent: node, fnId })
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
