import { lstat, readFile, realpath } from 'node:fs/promises'
import * as nodeModule from 'node:module'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'
import * as acorn from 'acorn'

import { COMMON_HOOKS_FILE, COMMON_MODULE_TYPES_SPECIFIER } from '../common-layout-names.js'
import type { ShellHookEvent } from '../shell-hook.js'
import { resolvePattern } from './events.js'

/** The most one scanned file, and the hooks file, may hold. */
export const MAX_MODULE_FILE_BYTES = 1024 * 1024
/** The most all the files of one module may hold together. */
export const MAX_MODULE_TOTAL_BYTES = 8 * 1024 * 1024
/** The most files one module may be made of. */
export const MAX_MODULE_FILES = 64

/** The calls on `$` Namzu answers, by noun. Every other call throws where it is made. */
export const SUPPORTED_CAPABILITY_CALLS: Readonly<Record<string, readonly string[]>> = {
	fs: ['read', 'exists', 'stat', 'list'],
	store: ['get', 'set', 'delete', 'keys'],
	process: ['run'],
	env: ['get'],
	ui: ['log'],
	http: ['fetch'],
}

/** The properties of `$.plugin` a module may read. */
export const PLUGIN_PROPERTIES: readonly string[] = ['root', 'name']

export interface ScanRefusal {
	/** The file, relative to the plugin. */
	readonly file: string
	readonly line: number
	readonly message: string
}

export interface ScannedHook {
	readonly pattern: string
	readonly file: string
	readonly line: number
	/** Registered with a matcher. */
	readonly matcher: boolean
	/** Given a `.catch`. */
	readonly catches: boolean
	/** The Namzu events it runs on; empty when none of what it names exists here. */
	readonly runs: readonly ShellHookEvent[]
	/** Why the pattern runs nowhere, when it does not. */
	readonly notUsed?: string
}

export interface ScannedCall {
	/** `$.fs.read`. */
	readonly call: string
	readonly file: string
	readonly line: number
	/** False when Namzu has no such call; calling it throws. */
	readonly supported: boolean
}

/** What the worker runs: every file of the module, rewritten to run as a script. */
export interface HookModuleProgram {
	/** The entry, relative to the plugin. */
	readonly entry: string
	/** Plugin-relative path to rewritten source. */
	readonly files: Readonly<Record<string, string>>
}

export interface HookModuleScan {
	/** The entry, relative to the plugin. */
	readonly entry: string
	/** Every file the module is made of, relative to the plugin. */
	readonly files: readonly string[]
	readonly hooks: readonly ScannedHook[]
	readonly calls: readonly ScannedCall[]
	/** The variables the module reads, by literal name. */
	readonly envNames: readonly string[]
	readonly refusals: readonly ScanRefusal[]
	/** Present when nothing was refused. */
	readonly program?: HookModuleProgram
}

type AnyNode = acorn.Node & { [key: string]: any }

type TypeStripper = (code: string, options?: { mode?: 'strip' | 'transform' }) => string

/** `stripTypeScriptTypes` where this Node has it, quiet about its experimental status. */
function typeStripper(): TypeStripper | undefined {
	const stripper = (nodeModule as { stripTypeScriptTypes?: TypeStripper }).stripTypeScriptTypes
	if (typeof stripper !== 'function') return undefined
	return (code, options) => {
		const original = process.emitWarning
		process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
			const text = typeof warning === 'string' ? warning : String((warning as Error)?.message ?? '')
			if (/type stripping/i.test(text)) return
			return (original as (...args: unknown[]) => void).call(process, warning, ...rest)
		}) as typeof process.emitWarning
		try {
			return stripper(code, options)
		} finally {
			process.emitWarning = original
		}
	}
}

/** The path inside `root`, or `undefined` when it leaves it. */
function within(root: string, path: string): boolean {
	const rel = relative(root, path)
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export type PluginFileRead =
	| { readonly text: string; readonly real: string }
	| { readonly problem: string }

/**
 * A plugin's file as text: a regular file inside the plugin, not a link, no
 * larger than `cap`. A problem says why it was not read.
 */
export async function readPluginFile(
	root: string,
	rel: string,
	cap: number = MAX_MODULE_FILE_BYTES,
): Promise<PluginFileRead> {
	const path = resolve(root, rel)
	let realRoot: string
	try {
		realRoot = await realpath(root)
	} catch {
		return { problem: 'the plugin folder cannot be read' }
	}
	if (!within(resolve(root), path)) return { problem: 'is outside the plugin folder' }
	let info: Awaited<ReturnType<typeof lstat>>
	try {
		info = await lstat(path)
	} catch {
		return { problem: 'no such file' }
	}
	if (info.isSymbolicLink()) return { problem: 'is a link, and links are not followed' }
	if (!info.isFile()) return { problem: 'is not a regular file' }
	if (info.size > cap) return { problem: `is larger than ${cap / 1024} KiB` }
	let real: string
	try {
		real = await realpath(path)
	} catch {
		return { problem: 'no such file' }
	}
	if (!within(realRoot, real)) return { problem: 'leaves the plugin folder through a link' }
	try {
		return { text: await readFile(real, 'utf8'), real }
	} catch {
		return { problem: 'cannot be read' }
	}
}

export type HookModuleLocation =
	| { readonly kind: 'none' }
	| {
			readonly kind: 'found'
			/** The hooks file that names it, relative to the plugin. */
			readonly hooksFile: string
			/** As the hooks file spells it. */
			readonly specifier: string
			/** Relative to the plugin, with `/`. */
			readonly entry: string
	  }
	| { readonly kind: 'refused'; readonly hooksFile: string; readonly message: string }

/**
 * Read the hooks file of the common layout for the module it names: `modules`
 * holds one path, relative to the folder the hooks file is in. The file is read
 * as the hook entries are: no link, valid JSON, one mebibyte at most.
 */
export async function locateHookModule(root: string): Promise<HookModuleLocation> {
	const hooksFile = COMMON_HOOKS_FILE
	const read = await readPluginFile(root, hooksFile)
	if ('problem' in read) {
		// A missing file is not a module; any other problem is the hook entries' to say.
		return { kind: 'none' }
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(read.text)
	} catch {
		return { kind: 'none' }
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
		return { kind: 'none' }
	const modules = (parsed as Record<string, unknown>).modules
	if (modules === undefined) return { kind: 'none' }
	if (!Array.isArray(modules)) {
		return {
			kind: 'refused',
			hooksFile,
			message: `${hooksFile}: "modules" must be a list of one path.`,
		}
	}
	if (modules.length === 0) return { kind: 'none' }
	if (modules.length > 1) {
		return {
			kind: 'refused',
			hooksFile,
			message: `${hooksFile}: \`modules\` names one hooks module per plugin; a second entry is refused.`,
		}
	}
	const specifier = modules[0]
	if (typeof specifier !== 'string' || specifier.trim() === '') {
		return { kind: 'refused', hooksFile, message: `${hooksFile}: \`modules\` must name a file.` }
	}
	if (isAbsolute(specifier) || /^[A-Za-z]:/.test(specifier) || specifier.startsWith('\\')) {
		return {
			kind: 'refused',
			hooksFile,
			message: `${hooksFile}: "${specifier}" is an absolute path; a module is named relative to the hooks file.`,
		}
	}
	const entry = posix.normalize(
		posix.join(posix.dirname(hooksFile), specifier.replaceAll('\\', '/')),
	)
	if (entry === '..' || entry.startsWith('../') || posix.isAbsolute(entry)) {
		return {
			kind: 'refused',
			hooksFile,
			message: `${hooksFile}: "${specifier}" leaves the plugin folder.`,
		}
	}
	return { kind: 'found', hooksFile, specifier, entry }
}

const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs']
const TYPED_EXTENSIONS = ['.ts', '.mts', '.cts']

function extensionOf(path: string): string {
	const index = path.lastIndexOf('.')
	return index < 0 ? '' : path.slice(index).toLowerCase()
}

function walk(
	node: AnyNode,
	enter: (node: AnyNode, parents: AnyNode[]) => void,
	parents: AnyNode[] = [],
): void {
	enter(node, parents)
	parents.push(node)
	for (const key of Object.keys(node)) {
		if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue
		const value = node[key]
		if (Array.isArray(value)) {
			for (const child of value) {
				if (child !== null && typeof child === 'object' && typeof child.type === 'string') {
					walk(child as AnyNode, enter, parents)
				}
			}
		} else if (value !== null && typeof value === 'object' && typeof value.type === 'string') {
			walk(value as AnyNode, enter, parents)
		}
	}
	parents.pop()
}

function isFunctionNode(node: AnyNode | undefined): boolean {
	return (
		node !== undefined &&
		(node.type === 'FunctionDeclaration' ||
			node.type === 'FunctionExpression' ||
			node.type === 'ArrowFunctionExpression')
	)
}

function stringValue(node: AnyNode | undefined): string | undefined {
	if (node === undefined) return undefined
	if (node.type === 'Literal' && typeof node.value === 'string') return node.value
	if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
		return node.quasis[0]?.value?.cooked ?? undefined
	}
	return undefined
}

function patternNames(node: AnyNode | null | undefined, into: string[]): void {
	if (node === null || node === undefined) return
	switch (node.type) {
		case 'Identifier':
			into.push(node.name)
			return
		case 'ObjectPattern':
			for (const property of node.properties) {
				patternNames(property.type === 'RestElement' ? property.argument : property.value, into)
			}
			return
		case 'ArrayPattern':
			for (const element of node.elements) patternNames(element, into)
			return
		case 'AssignmentPattern':
			patternNames(node.left, into)
			return
		case 'RestElement':
			patternNames(node.argument, into)
			return
	}
}

/** Blank a stretch of source, keeping its line breaks so line numbers stay true. */
function blank(text: string): string {
	return text.replace(/[^\n]/g, ' ')
}

interface FileAnalysis {
	readonly rel: string
	readonly ast: AnyNode
	/** Source after the types are stripped. */
	readonly code: string
	/** Relative imports, as written, in order. */
	readonly imports: { readonly specifier: string; readonly line: number }[]
}

interface ScanState {
	readonly root: string
	readonly refusals: ScanRefusal[]
	readonly hooks: ScannedHook[]
	readonly calls: ScannedCall[]
	readonly envNames: Set<string>
	readonly analyses: Map<string, FileAnalysis>
	readonly rewritten: Map<string, string>
	total: number
}

function refuse(state: ScanState, file: string, node: AnyNode | number, message: string): void {
	const line = typeof node === 'number' ? node : (node.loc?.start.line ?? 1)
	state.refusals.push({ file, line, message })
}

async function resolveImport(
	state: ScanState,
	fromRel: string,
	specifier: string,
): Promise<string | undefined> {
	const base = posix.normalize(posix.join(posix.dirname(fromRel), specifier))
	if (base.startsWith('../') || base === '..' || posix.isAbsolute(base)) return undefined
	const candidates = [base]
	if (/\.m?js$/.test(base)) candidates.push(base.replace(/\.(m?)js$/, '.$1ts'))
	for (const extension of ['.ts', '.js', '.mjs']) candidates.push(`${base}${extension}`)
	for (const candidate of candidates) {
		const info = await lstat(join(state.root, candidate)).catch(() => undefined)
		if (info !== undefined && (info.isFile() || info.isSymbolicLink())) return candidate
	}
	return undefined
}

/** Which top-level bindings of a file are functions, by name. */
function topLevelFunctions(ast: AnyNode): Map<string, AnyNode> {
	const found = new Map<string, AnyNode>()
	for (const statement of ast.body as AnyNode[]) {
		const declaration =
			statement.type === 'ExportNamedDeclaration'
				? (statement.declaration as AnyNode | null)
				: statement
		if (declaration === null || declaration === undefined) continue
		if (declaration.type === 'FunctionDeclaration' && declaration.id !== null) {
			found.set(declaration.id.name, declaration)
		} else if (declaration.type === 'VariableDeclaration') {
			for (const declarator of declaration.declarations as AnyNode[]) {
				if (declarator.id.type === 'Identifier' && isFunctionNode(declarator.init)) {
					found.set(declarator.id.name, declarator.init)
				}
			}
		}
	}
	return found
}

/** The function the entry exports as `register`, or as its default. */
function findRegister(ast: AnyNode, functions: Map<string, AnyNode>): AnyNode | undefined {
	for (const statement of ast.body as AnyNode[]) {
		if (statement.type === 'ExportNamedDeclaration') {
			const declaration = statement.declaration as AnyNode | null
			if (declaration?.type === 'FunctionDeclaration' && declaration.id?.name === 'register') {
				return declaration
			}
			if (declaration?.type === 'VariableDeclaration') {
				for (const declarator of declaration.declarations as AnyNode[]) {
					if (declarator.id.type === 'Identifier' && declarator.id.name === 'register') {
						return isFunctionNode(declarator.init) ? declarator.init : undefined
					}
				}
			}
			for (const specifier of (statement.specifiers ?? []) as AnyNode[]) {
				if (specifier.exported.name === 'register' && statement.source === null) {
					return functions.get(specifier.local.name)
				}
			}
		} else if (statement.type === 'ExportDefaultDeclaration') {
			const declaration = statement.declaration as AnyNode
			if (isFunctionNode(declaration)) return declaration
			if (declaration.type === 'Identifier') return functions.get(declaration.name)
		}
	}
	return undefined
}

function capabilityUse(state: ScanState, rel: string, node: AnyNode, parents: AnyNode[]): void {
	const parent = parents[parents.length - 1]
	const grand = parents[parents.length - 2]
	const great = parents[parents.length - 3]
	const spelled = '$ is always spelled $.noun.event(...) at the call site'
	if (
		parent?.type !== 'MemberExpression' ||
		parent.object !== node ||
		parent.computed === true ||
		parent.property.type !== 'Identifier'
	) {
		refuse(state, rel, node, spelled)
		return
	}
	const noun = parent.property.name as string
	if (
		grand?.type !== 'MemberExpression' ||
		grand.object !== parent ||
		grand.computed === true ||
		grand.property.type !== 'Identifier'
	) {
		refuse(state, rel, node, spelled)
		return
	}
	const member = grand.property.name as string
	const called = great?.type === 'CallExpression' && great.callee === grand
	if (noun === 'plugin' && !called && PLUGIN_PROPERTIES.includes(member)) return
	if (!called) {
		refuse(state, rel, node, spelled)
		return
	}
	const supported = SUPPORTED_CAPABILITY_CALLS[noun]?.includes(member) === true
	state.calls.push({
		call: `$.${noun}.${member}`,
		file: rel,
		line: node.loc?.start.line ?? 1,
		supported,
	})
	if (noun === 'env' && member === 'get' && supported) {
		const name = stringValue(great.arguments[0] as AnyNode | undefined)
		if (name === undefined) {
			refuse(
				state,
				rel,
				node,
				'$.env.get takes a string literal: the variables a module reads are listed before it loads',
			)
		} else state.envNames.add(name)
	}
}

/**
 * Read one file: parse it, refuse what is refused, and note what it hooks and
 * calls. The entry file also has its `register` function read for `on` calls.
 */
async function analyseFile(
	state: ScanState,
	rel: string,
	isEntry: boolean,
	queue: string[],
): Promise<void> {
	const extension = extensionOf(rel)
	if (extension === '.tsx' || extension === '.jsx') {
		refuse(state, rel, 1, `${rel}: JSX is not supported in a hooks module.`)
		return
	}
	if (!SCRIPT_EXTENSIONS.includes(extension) && !TYPED_EXTENSIONS.includes(extension)) {
		refuse(
			state,
			rel,
			1,
			`${rel}: only .js, .mjs, .cjs, .ts, .mts and .cts files are loaded as a hooks module.`,
		)
		return
	}
	const read = await readPluginFile(state.root, rel)
	if ('problem' in read) {
		refuse(state, rel, 1, `${rel}: ${read.problem}.`)
		return
	}
	state.total += read.text.length
	if (state.total > MAX_MODULE_TOTAL_BYTES) {
		refuse(
			state,
			rel,
			1,
			`${rel}: the module's files together are past ${MAX_MODULE_TOTAL_BYTES / 1024 / 1024} MiB.`,
		)
		return
	}
	let code = read.text
	if (TYPED_EXTENSIONS.includes(extension)) {
		const strip = typeStripper()
		if (strip === undefined) {
			refuse(
				state,
				rel,
				1,
				`${rel}: a TypeScript module needs Node 22.13 or later; write it as .js or run a newer Node.`,
			)
			return
		}
		try {
			code = strip(code, { mode: 'strip' })
		} catch (error) {
			const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
			refuse(state, rel, 1, `${rel} does not parse as TypeScript: ${message}`)
			return
		}
	}
	let ast: AnyNode
	try {
		ast = acorn.parse(code, {
			ecmaVersion: 'latest',
			sourceType: 'module',
			locations: true,
			allowHashBang: true,
		}) as unknown as AnyNode
	} catch (error) {
		const problem = error as { message?: string; loc?: { line: number; column: number } }
		const text = (problem.message ?? String(error)).replace(/\s*\(\d+:\d+\)$/, '')
		refuse(
			state,
			rel,
			problem.loc?.line ?? 1,
			`${rel} does not parse: ${text} (line ${problem.loc?.line ?? 1}, column ${(problem.loc?.column ?? 0) + 1})`,
		)
		return
	}

	const imports: FileAnalysis['imports'][number][] = []
	const importedNames = new Map<string, 'function-ok' | 'namespace'>()
	for (const statement of ast.body as AnyNode[]) {
		const isImport = statement.type === 'ImportDeclaration'
		const isReexport =
			(statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportAllDeclaration') &&
			statement.source !== null &&
			statement.source !== undefined
		if (!isImport && !isReexport) continue
		const specifier = String(statement.source.value)
		if (specifier.startsWith('./') || specifier.startsWith('../')) {
			imports.push({ specifier, line: statement.loc?.start.line ?? 1 })
			if (isImport) {
				for (const item of statement.specifiers as AnyNode[]) {
					importedNames.set(
						item.local.name,
						item.type === 'ImportNamespaceSpecifier' ? 'namespace' : 'function-ok',
					)
				}
			}
		} else if (specifier === COMMON_MODULE_TYPES_SPECIFIER) {
			refuse(
				state,
				rel,
				statement,
				`${rel}: cannot import "${specifier}" as a value (from ${rel}): it holds types only, and only import type is read.`,
			)
		} else {
			refuse(
				state,
				rel,
				statement,
				`${rel}: cannot import "${specifier}" (from ${rel}): a hooks module imports its own files by relative path and "${COMMON_MODULE_TYPES_SPECIFIER}", nothing else`,
			)
		}
	}

	const functions = topLevelFunctions(ast)
	const register = isEntry ? findRegister(ast, functions) : undefined
	if (isEntry && register === undefined) {
		refuse(
			state,
			rel,
			1,
			`${rel}: the module does not export a function named register (export function register(on) { ... }).`,
		)
	}
	let onName: string | undefined
	if (register !== undefined) {
		const first = (register.params as AnyNode[])[0]
		if (first !== undefined) {
			if (first.type === 'Identifier') onName = first.name
			else refuse(state, rel, register, `${rel}: register takes on as a plain first parameter.`)
		}
	}
	const inRegister = (node: AnyNode): boolean =>
		register !== undefined && node.start >= register.start && node.end <= register.end

	const patterns = new Map<string, ScannedHook>()
	walk(ast, (node, parents) => {
		const parent = parents[parents.length - 1]
		if (node.type === 'ImportExpression') {
			refuse(
				state,
				rel,
				node,
				`${rel}: a dynamic import(); a hooks module imports its own files with an import declaration, as in import { name } from "./file.js"`,
			)
			return
		}
		if (node.type === 'MetaProperty' && node.meta.name === 'import') {
			refuse(state, rel, node, `${rel}: import.meta is not available in a hooks module.`)
			return
		}
		if (
			(node.type === 'AwaitExpression' ||
				(node.type === 'ForOfStatement' && node.await === true)) &&
			!parents.some(isFunctionNode)
		) {
			refuse(
				state,
				rel,
				node,
				`${rel}: a top-level await in a file the entry imports; the environment links the entry alone as an async module`,
			)
			return
		}
		if (node.type !== 'Identifier') {
			if (
				node.type === 'CallExpression' &&
				onName !== undefined &&
				node.callee.type === 'Identifier' &&
				node.callee.name === onName &&
				inRegister(node)
			) {
				registration(state, rel, node, parents, functions, importedNames, patterns)
			}
			return
		}
		// An identifier that is not a use: a property key or name, a parameter.
		if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) return
		if (
			parent?.type === 'Property' &&
			parent.key === node &&
			!parent.computed &&
			!parent.shorthand
		) {
			return
		}
		if (node.name === '$') {
			const declared = parents.some((ancestor) => {
				if (!isFunctionNode(ancestor)) return false
				return (ancestor.params as AnyNode[]).some((param) => {
					const names: string[] = []
					patternNames(param, names)
					return names.includes('$') && param.start <= node.start && node.end <= param.end
				})
			})
			if (declared) return
			if (parent?.type === 'VariableDeclarator' && parent.id === node) {
				refuse(
					state,
					rel,
					node,
					`${rel}: $ is declared again in this file; it is the capability object and is spelled $.noun.event(...)`,
				)
				return
			}
			capabilityUse(state, rel, node, parents)
			return
		}
		if (onName !== undefined && node.name === onName && inRegister(node)) {
			const isParam = parent === register && (register?.params as AnyNode[]).includes(node)
			const isCallee = parent?.type === 'CallExpression' && parent.callee === node
			if (!isParam && !isCallee) {
				refuse(
					state,
					rel,
					node,
					`${rel}: on is always on("<event>", hook): it is not passed, bound or assigned`,
				)
			}
		}
	})

	state.analyses.set(rel, { rel, ast, code, imports })
	for (const item of imports) {
		const target = await resolveImport(state, rel, item.specifier)
		if (target === undefined) {
			refuse(
				state,
				rel,
				item.line,
				`${rel}: cannot import "${item.specifier}" (from ${rel}): no such file in the plugin`,
			)
		} else if (!state.analyses.has(target) && !queue.includes(target)) {
			if (state.analyses.size + queue.length >= MAX_MODULE_FILES) {
				refuse(
					state,
					rel,
					item.line,
					`${rel}: the module is made of more than ${MAX_MODULE_FILES} files.`,
				)
			} else queue.push(target)
		}
	}
}

function registration(
	state: ScanState,
	rel: string,
	call: AnyNode,
	parents: AnyNode[],
	functions: Map<string, AnyNode>,
	importedNames: Map<string, 'function-ok' | 'namespace'>,
	patterns: Map<string, ScannedHook>,
): void {
	const args = call.arguments as AnyNode[]
	if (args.length < 2 || args.length > 3) {
		refuse(state, rel, call, `${rel}: on() takes (pattern, hook) or (pattern, matcher, hook)`)
		return
	}
	const pattern = stringValue(args[0])
	if (pattern === undefined) {
		refuse(state, rel, call, `${rel}: the event name passed to on() is not a string literal`)
		return
	}
	const resolved = resolvePattern(pattern)
	if (!resolved.ok) {
		refuse(state, rel, call, `${rel}: ${resolved.message}`)
		return
	}
	const hook = args[args.length - 1] as AnyNode
	let isFunction = isFunctionNode(hook)
	if (!isFunction && hook.type === 'Identifier') {
		if (importedNames.get(hook.name) === 'namespace') {
			refuse(state, rel, hook, `${rel}: "${hook.name}" is a namespace import, not a function`)
			return
		}
		isFunction = functions.has(hook.name) || importedNames.has(hook.name)
	}
	if (!isFunction) {
		refuse(
			state,
			rel,
			hook,
			`${rel}: the hook passed to on("${pattern}") is not a function declared at the top of this file (a function declaration, or a const bound to a function), nor imported from one of the module's own files`,
		)
		return
	}
	const matcher = args.length === 3
	if (!matcher) {
		const earlier = patterns.get(pattern)
		if (earlier !== undefined) {
			refuse(
				state,
				rel,
				call,
				`${rel}: on("${pattern}") is registered twice without a matcher; the first is at ${earlier.file}:${earlier.line}`,
			)
			return
		}
	}
	const parent = parents[parents.length - 1]
	const catches =
		parent?.type === 'MemberExpression' &&
		parent.object === call &&
		parent.property.type === 'Identifier' &&
		parent.property.name === 'catch'
	const scanned: ScannedHook = {
		pattern,
		file: rel,
		line: call.loc?.start.line ?? 1,
		matcher,
		catches,
		runs: resolved.runs,
		...(resolved.notUsed !== undefined ? { notUsed: resolved.notUsed } : {}),
	}
	if (!matcher) patterns.set(pattern, scanned)
	state.hooks.push(scanned)
}

interface Edit {
	readonly start: number
	readonly end: number
	readonly text: string
}

/**
 * Rewrite one file to run as a script: imports become reads of the importing
 * file's neighbours, exports become assignments, and nothing else changes, so a
 * line number in an error is the line in the author's file.
 */
function rewrite(code: string, ast: AnyNode, resolved: ReadonlyMap<string, string>): string {
	const edits: Edit[] = []
	const prelude: string[] = []
	const tail: string[] = []
	let counter = 0
	const target = (specifier: string): string => JSON.stringify(resolved.get(specifier) ?? specifier)
	for (const statement of ast.body as AnyNode[]) {
		const span = (): Edit => ({
			start: statement.start,
			end: statement.end,
			text: blank(code.slice(statement.start, statement.end)),
		})
		switch (statement.type) {
			case 'ImportDeclaration': {
				const specifier = String(statement.source.value)
				const variable = `__m${counter++}`
				prelude.push(`const ${variable} = __import(${target(specifier)});`)
				for (const item of statement.specifiers as AnyNode[]) {
					if (item.type === 'ImportDefaultSpecifier') {
						prelude.push(`const ${item.local.name} = ${variable}.default;`)
					} else if (item.type === 'ImportNamespaceSpecifier') {
						prelude.push(`const ${item.local.name} = ${variable};`)
					} else {
						prelude.push(
							`const ${item.local.name} = ${variable}[${JSON.stringify(item.imported.name ?? item.imported.value)}];`,
						)
					}
				}
				edits.push(span())
				break
			}
			case 'ExportNamedDeclaration': {
				if (statement.source !== null && statement.source !== undefined) {
					const variable = `__m${counter++}`
					prelude.push(`const ${variable} = __import(${target(String(statement.source.value))});`)
					for (const item of statement.specifiers as AnyNode[]) {
						const exported = item.exported.name ?? item.exported.value
						const local = item.local.name ?? item.local.value
						tail.push(
							`__exports[${JSON.stringify(exported)}] = ${variable}[${JSON.stringify(local)}];`,
						)
					}
					edits.push(span())
				} else if (statement.declaration !== null && statement.declaration !== undefined) {
					const declaration = statement.declaration as AnyNode
					edits.push({
						start: statement.start,
						end: declaration.start,
						text: blank(code.slice(statement.start, declaration.start)),
					})
					const names: string[] = []
					if (declaration.type === 'VariableDeclaration') {
						for (const declarator of declaration.declarations as AnyNode[]) {
							patternNames(declarator.id, names)
						}
					} else if (declaration.id) names.push(declaration.id.name)
					for (const name of names) tail.push(`__exports[${JSON.stringify(name)}] = ${name};`)
				} else {
					for (const item of statement.specifiers as AnyNode[]) {
						tail.push(
							`__exports[${JSON.stringify(item.exported.name ?? item.exported.value)}] = ${item.local.name};`,
						)
					}
					edits.push(span())
				}
				break
			}
			case 'ExportAllDeclaration': {
				const variable = `__m${counter++}`
				prelude.push(`const ${variable} = __import(${target(String(statement.source.value))});`)
				if (statement.exported) {
					tail.push(
						`__exports[${JSON.stringify(statement.exported.name ?? statement.exported.value)}] = ${variable};`,
					)
				} else {
					tail.push(
						`for (const __k of Object.keys(${variable})) { if (__k !== "default") __exports[__k] = ${variable}[__k]; }`,
					)
				}
				edits.push(span())
				break
			}
			case 'ExportDefaultDeclaration': {
				const declaration = statement.declaration as AnyNode
				const named =
					(declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') &&
					declaration.id !== null &&
					declaration.id !== undefined
				if (named) {
					edits.push({
						start: statement.start,
						end: declaration.start,
						text: blank(code.slice(statement.start, declaration.start)),
					})
					tail.push(`__exports.default = ${declaration.id.name};`)
				} else {
					edits.push({
						start: statement.start,
						end: declaration.start,
						text: '__exports.default = ',
					})
					edits.push({ start: statement.end, end: statement.end, text: ';' })
				}
				break
			}
		}
	}
	let out = code
	for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
		out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
	}
	return `${prelude.join(' ')}${out}\n${tail.join('\n')}`
}

/**
 * Read a plugin's hooks module before anything runs it: the files it is made
 * of, what it hooks, what it calls on `$`, and whatever the module is refused
 * for. Nothing here runs the module.
 */
export async function scanHookModule(root: string, entry: string): Promise<HookModuleScan> {
	const state: ScanState = {
		root: resolve(root),
		refusals: [],
		hooks: [],
		calls: [],
		envNames: new Set(),
		analyses: new Map(),
		rewritten: new Map(),
		total: 0,
	}
	const queue: string[] = [entry]
	const entryRel = entry
	while (queue.length > 0) {
		const next = queue.shift() as string
		if (state.analyses.has(next)) continue
		await analyseFile(state, next, next === entryRel, queue)
	}
	let program: HookModuleProgram | undefined
	if (state.refusals.length === 0) {
		const files: Record<string, string> = {}
		for (const [rel, analysis] of state.analyses) {
			const resolved = new Map<string, string>()
			for (const item of analysis.imports) {
				const target = await resolveImport(state, rel, item.specifier)
				if (target !== undefined) resolved.set(item.specifier, target)
			}
			files[rel] = rewrite(analysis.code, analysis.ast, resolved)
		}
		program = { entry: entryRel, files }
	}
	return {
		entry: entryRel,
		files: [...state.analyses.keys()],
		hooks: state.hooks,
		calls: state.calls,
		envNames: [...state.envNames].sort(),
		refusals: state.refusals,
		...(program !== undefined ? { program } : {}),
	}
}
