#!/usr/bin/env node
/**
 * A type named in an exported signature is exported too.
 *
 * ## The defect this exists for
 *
 * A callable value or class reaches the public surface and the types in its
 * signature do not. The value/constructor is callable, and a consumer who
 * wants to name what they pass or
 * what they got back cannot: they inline the shape, or reach for `any`, and
 * either way the package's own vocabulary stops at the function name.
 *
 * It is invisible from inside. The declaring package imports those types by
 * path, so nothing there notices; `tsc` is happy, the public-surface gate sees
 * a name it recorded, and the build is green. It surfaces only when somebody
 * writes the first consumer — which is how all three known cases were found,
 * each by being that consumer:
 *
 *  - `SpanProcessorLike`, required by `TelemetryConfig.spanProcessors`
 *  - `CompactNowInput` and `CompactionResult`, the parameter and return of
 *    `compactNow`
 *
 * Three of the same defect in two days, each found by accident, is the profile
 * of something that needs a check rather than more care.
 *
 * ## What it flags, and what it must not
 *
 * Only types this package DECLARES. A signature naming `Promise`, `Record` or a
 * type from a dependency is fine — those are not this package's to export, and
 * flagging them would make the gate unusable on its first run.
 *
 * Type PARAMETERS are not references: `<T>(x: T) => T` names nothing a consumer
 * could import.
 *
 * Scope is every publishable package with built types, derived from the
 * workspace rather than listed — the same reason the sibling gates derive
 * theirs.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..'))
const rel = (p) => relative(root, p).split('\\').join('/')

/** Every publishable package's built `types` entry, derived from the tree. */
function packageTypeEntries() {
	const out = []
	const packagesDir = join(root, 'packages')
	if (!existsSync(packagesDir)) return out
	const dirs = []
	for (const name of readdirSync(packagesDir)) {
		if (name === 'node_modules') continue
		const dir = join(packagesDir, name)
		if (!statSync(dir).isDirectory()) continue
		if (existsSync(join(dir, 'package.json'))) dirs.push(dir)
		else
			for (const nested of readdirSync(dir)) {
				if (nested === 'node_modules') continue
				const nestedDir = join(dir, nested)
				if (statSync(nestedDir).isDirectory() && existsSync(join(nestedDir, 'package.json')))
					dirs.push(nestedDir)
			}
	}
	for (const dir of dirs) {
		const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
		if (manifest.private || !manifest.types) continue
		const typesPath = join(dir, manifest.types)
		if (existsSync(typesPath)) out.push({ name: manifest.name, dir, typesPath })
	}
	return out
}

/**
 * Type identifiers named in a declaration's signature.
 *
 * Read off the AST rather than the resolved type. A resolved type has already
 * been expanded — an alias becomes the thing it aliases, and the NAME a
 * consumer would have written disappears. The name is precisely what is under
 * test here.
 */
function referencedTypeNames(decl) {
	const found = new Set()
	const typeParams = new Set()
	// A constructor's generic parameters live on its containing class, not on
	// the ConstructorDeclaration itself. Without walking the owner,
	// `ManagedRegistry<TDefinition>` was reported as if `TDefinition` were a
	// hidden package type rather than a consumer-supplied type parameter.
	for (let current = decl; current; current = current.parent) {
		for (const parameter of current.typeParameters ?? []) typeParams.add(parameter.name.text)
	}

	const visitType = (node) => {
		if (ts.isTypeReferenceNode(node)) {
			const name = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text
			// A qualified name (`ns.Thing`) is reached through its namespace,
			// which the consumer imports; only the bare case is ours to check.
			if (ts.isIdentifier(node.typeName) && !typeParams.has(name)) found.add(name)
		}
		ts.forEachChild(node, visitType)
	}

	for (const param of decl.parameters ?? []) if (param.type) visitType(param.type)
	if (decl.type) visitType(decl.type)
	return found
}

/** Whether a class member is callable from a package consumer. */
function isPublicClassMember(decl) {
	const flags = ts.getCombinedModifierFlags(decl)
	return (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) === 0
}

/** Signatures exposed by one declaration at the package root. */
function exposedSignatures(decl) {
	const out = []
	if (ts.isFunctionDeclaration(decl) || ts.isMethodSignature(decl)) out.push(decl)
	else if (ts.isVariableDeclaration(decl) && decl.type && ts.isFunctionTypeNode(decl.type))
		out.push(decl.type)
	else if (ts.isClassDeclaration(decl)) {
		for (const member of decl.members) {
			if (ts.isConstructorDeclaration(member) && isPublicClassMember(member)) out.push(member)
		}
	}
	return out
}

/** Declarations whose signature a consumer has to be able to name. */
function signatureDeclarations(symbol, checker) {
	const target =
		(symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
	return (target.getDeclarations() ?? []).flatMap(exposedSignatures)
}

// This gate used to inspect free functions only. A root-exported class could
// name an unreachable constructor dependency and still pass — precisely how
// `AgentManagerDeps` shipped. Keep the class branch falsifiable inside the
// command CI already runs; a detached unit file would not be part of that gate.
const constructorProbe = ts.createSourceFile(
	'constructor-probe.d.ts',
	'export declare class PublicThing { constructor(deps: HiddenDeps) }\ninterface HiddenDeps {}',
	ts.ScriptTarget.Latest,
	/* setParentNodes */ true,
	ts.ScriptKind.TS,
)
const probeClass = constructorProbe.statements.find(ts.isClassDeclaration)
if (!probeClass || exposedSignatures(probeClass).filter(ts.isConstructorDeclaration).length !== 1) {
	throw new Error('signature-type gate self-check failed: public constructors are not inspected')
}

const entries = packageTypeEntries()
const problems = []
let checkedPackages = 0
let checkedSignatures = 0

for (const entry of entries) {
	const program = ts.createProgram([entry.typesPath], {
		noEmit: true,
		skipLibCheck: true,
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
	})
	const source = program.getSourceFile(entry.typesPath)
	if (!source) continue
	const checker = program.getTypeChecker()
	const moduleSymbol = checker.getSymbolAtLocation(source)
	if (!moduleSymbol) continue
	checkedPackages += 1

	const exported = checker.getExportsOfModule(moduleSymbol)
	const exportedNames = new Set(exported.map((s) => s.getName()))
	const packageRoot = entry.dir

	for (const symbol of exported) {
		for (const decl of signatureDeclarations(symbol, checker)) {
			checkedSignatures += 1
			for (const name of referencedTypeNames(decl)) {
				if (exportedNames.has(name)) continue

				// Resolve the name to find out WHOSE it is. Only a type declared
				// inside this package is this package's to export; a global or a
				// dependency's type is not, and flagging it would make the gate
				// unusable rather than strict.
				let resolved = checker.resolveName(
					name,
					decl,
					ts.SymbolFlags.Type,
					/* excludeGlobals */ false,
				)
				// Through the alias, always. A type IMPORTED from a sibling
				// package resolves to the `import` specifier, whose source file
				// is this package's own `.d.ts` — so without this hop every
				// borrowed type reads as locally declared and the gate demands a
				// package re-export something it does not own. That was 50 of its
				// first 57 findings.
				while (resolved && (resolved.flags & ts.SymbolFlags.Alias) !== 0) {
					const next = checker.getAliasedSymbol(resolved)
					if (!next || next === resolved) break
					resolved = next
				}
				const declaredIn = resolved?.getDeclarations()?.[0]?.getSourceFile().fileName
				if (!declaredIn) continue
				const inThisPackage = resolve(declaredIn).startsWith(`${packageRoot}${'/'}`)
				if (!inThisPackage) continue

				problems.push(
					`${entry.name} exports \`${symbol.getName()}\` but not \`${name}\`, which its signature names.`,
					`    Declared in ${rel(declaredIn)}. A consumer can call the public value and`,
					'    cannot name what it takes or returns, so they inline the shape or use `any`.',
					`    Add \`${name}\` to this package's public exports.`,
				)
			}
		}
	}
}

// A gate that examined nothing passes for the wrong reason — and this one runs
// against BUILT types, so "nothing to examine" is the ordinary state of an
// unbuilt tree rather than an exotic failure.
if (checkedPackages === 0 || checkedSignatures === 0) {
	problems.push(
		`signature-type gate examined ${checkedPackages} package(s) and ${checkedSignatures} signature(s).`,
		'    Run `pnpm -r build` first: this reads each package\'s built `types` entry,',
		'    and reporting success over an unbuilt tree would make it decorative.',
	)
}

if (problems.length > 0) {
	console.log(`✗ SIGNATURE TYPES — ${problems.length} line(s):`)
	for (const line of problems) console.log(`  ${line}`)
	process.exit(1)
}

console.log(
	`✓ signature types exported — ${checkedSignatures} signature(s) across ${checkedPackages} package(s)`,
)
