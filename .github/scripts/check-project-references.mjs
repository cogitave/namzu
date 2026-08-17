#!/usr/bin/env node
/**
 * Every workspace dependency has a matching TypeScript project reference.
 *
 * ## The failure this exists for
 *
 * A package that depends on a sibling needs the dependency in TWO files:
 * `package.json`, so the module resolves, and `tsconfig.json#references`, so
 * `tsc --build` builds the sibling first and finds its `.d.ts`. Adding one and
 * forgetting the other is invisible on a developer's machine, because
 * `node_modules` already holds a built copy from an earlier install — and it
 * fails on CI, where the build starts from nothing, with
 * `TS2307: Cannot find module '@namzu/<sibling>'`.
 *
 * It has happened twice in this repository in one day: `@namzu/cli` gained a
 * dependency on `@namzu/telemetry` without the reference, and then on
 * `@namzu/deepseek` without the reference. The second time was after the first
 * had been diagnosed, which is the definition of a defect that needs a check
 * rather than a memory.
 *
 * The diagnosis is also slow out of proportion to the fix, because the error
 * arrives twice over: the missing module is reported, and then every type that
 * depended on the missing module's declaration merging is reported as its own
 * unrelated-looking error. Adding `deepseek` produced `Cannot find module` and
 * `Type '"deepseek"' is not assignable to …` in the same run, and only the
 * first was real.
 *
 * ## Scope, stated
 *
 * Every `package.json` under `packages/`, at both nesting depths, that has a
 * `tsconfig.json` beside it. `dependencies` and `devDependencies` are checked;
 * `peerDependencies` are NOT, on their own — a peer is a contract about the
 * consumer's tree, not necessarily something this package compiles against.
 * Every provider declares `@namzu/sdk` as both a peer and a devDependency, so
 * they are covered through the second.
 *
 * A dependency is "workspace" if its version starts with `workspace:` — a
 * declaration, not an inference from directory layout.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..'))
const rel = (p) => relative(root, p).split('\\').join('/')

/** Every package directory under `packages/`, at either nesting depth. */
function packageDirs() {
	const out = []
	const packagesDir = join(root, 'packages')
	if (!existsSync(packagesDir)) return out
	for (const name of readdirSync(packagesDir)) {
		if (name === 'node_modules') continue
		const dir = join(packagesDir, name)
		if (!statSync(dir).isDirectory()) continue
		if (existsSync(join(dir, 'package.json'))) {
			out.push(dir)
			continue
		}
		for (const nested of readdirSync(dir)) {
			if (nested === 'node_modules') continue
			const nestedDir = join(dir, nested)
			if (statSync(nestedDir).isDirectory() && existsSync(join(nestedDir, 'package.json'))) {
				out.push(nestedDir)
			}
		}
	}
	return out
}

/** `tsconfig.json` with comments stripped — this repo's are commented. */
function readTsconfig(file) {
	const raw = readFileSync(file, 'utf8')
	const stripped = raw
		.split('\n')
		.map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
		.join('\n')
	return JSON.parse(stripped)
}

/** Where a `@namzu/x` specifier lives on disk, by package name. */
function packageLocations(dirs) {
	const byName = new Map()
	for (const dir of dirs) {
		const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
		byName.set(manifest.name, dir)
	}
	return byName
}

const dirs = packageDirs()
const locations = packageLocations(dirs)

const problems = []
let checked = 0
let edges = 0

for (const dir of dirs) {
	const tsconfigPath = join(dir, 'tsconfig.json')
	if (!existsSync(tsconfigPath)) continue
	checked += 1

	const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
	const tsconfig = readTsconfig(tsconfigPath)
	const referenced = new Set(
		(tsconfig.references ?? []).map((r) => resolve(dirname(tsconfigPath), r.path)),
	)

	const declared = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) }
	for (const [name, range] of Object.entries(declared)) {
		if (typeof range !== 'string' || !range.startsWith('workspace:')) continue
		const target = locations.get(name)
		// A `workspace:` range naming a package that is not in the workspace is
		// its own defect, but `pnpm install` refuses that before this ever runs.
		if (!target) continue
		if (!existsSync(join(target, 'tsconfig.json'))) continue
		edges += 1
		if (referenced.has(target)) continue
		problems.push(
			`${rel(tsconfigPath)} is missing a project reference to ${name}`,
			`    ${rel(join(dir, 'package.json'))} depends on it with "${range}", so \`tsc --build\``,
			`    needs to build ${rel(target)} first. Add:`,
			`        { "path": "${relative(dir, target).split('\\').join('/')}" }`,
			'    to this tsconfig\'s "references".',
		)
	}
}

// A gate that examined nothing passes for the wrong reason. Both counts have
// to be non-zero: no packages means the walk stopped matching the tree, and no
// edges means every `workspace:` range disappeared — either way the run below
// would report success over an empty check.
if (checked === 0 || edges === 0) {
	problems.push(
		`project-reference gate examined ${checked} package(s) and ${edges} workspace edge(s).`,
		'    Reporting success on either being zero would make this decorative.',
	)
}

if (problems.length > 0) {
	console.log(`✗ PROJECT REFERENCES — ${problems.length} line(s):`)
	for (const line of problems) console.log(`  ${line}`)
	process.exit(1)
}

console.log(
	`✓ project references intact — ${edges} workspace edge(s) across ${checked} package(s)`,
)
