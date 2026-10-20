#!/usr/bin/env node
// Bundle the CLI into a code-split ES module tree under dist/.
//
// `tsc --build` emits only the declarations (tsconfig: emitDeclarationOnly). This script
// writes every runtime file: `dist/bin.js` (the published bin), `dist/index.js` (the package
// export), the resident runner worker, and the shared chunks. Static imports are merged;
// every `import()` stays its own chunk, so the lazy command graph still loads lazily.
//
// Kept external, because they are native, optional, or found by name or path at run time:
//   @namzu/browser, @namzu/sandbox, @namzu/telemetry, @namzu/computer-use  optional packages
//   node-pty, playwright-core, react-devtools-core, oxc-parser             native / by path / optional
//   (@namzu/analysis itself is bundled, as @namzu/decision is; only its native parser stays out)
//   quickjs-emscripten-core, @jitl/quickjs-wasmfile-release-sync           resolved by path
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(pkgDir, 'src')
const outDir = join(pkgDir, 'dist')
const ROOT_TOKEN = '__NAMZU_DIST_ROOT__'

const external = [
	'@namzu/browser',
	'@namzu/sandbox',
	'@namzu/telemetry',
	'@namzu/computer-use',
	'node-pty',
	'oxc-parser',
	'playwright-core',
	'react-devtools-core',
	'quickjs-emscripten-core',
	'@jitl/quickjs-wasmfile-release-sync',
]

const entries = {
	bin: join(srcDir, 'bin.ts'),
	index: join(srcDir, 'index.ts'),
	'integrations/resident/runner-worker': join(srcDir, 'integrations/resident/runner-worker.ts'),
}

/**
 * `import.meta.url` in this package's own sources names the file's place in the old one-file-per-
 * module layout (`../package.json`, `../../skills/`, `bin.js` next to it). A merged chunk sits
 * somewhere else, so each use is rewritten to that original path under the dist root, which is
 * located at run time from the file the code actually landed in.
 */
const importMetaUrl = {
	name: 'import-meta-url',
	setup(b) {
		b.onLoad({ filter: /\.tsx?$/ }, (args) => {
			if (!args.path.startsWith(srcDir + sep) || args.path.endsWith('.test.ts')) return undefined
			const text = readFileSync(args.path, 'utf8')
			if (!text.includes('import.meta.url')) return undefined
			const original = posix.join(
				...relative(srcDir, args.path).split(sep).slice(0, -1),
				`${posix.basename(args.path).replace(/\.tsx?$/, '')}.js`,
			)
			const replaced = text.replaceAll(
				'import.meta.url',
				`(${ROOT_TOKEN} + ${JSON.stringify(original)})`,
			)
			return { contents: replaced, loader: args.path.endsWith('x') ? 'tsx' : 'ts' }
		})
		// The SDK reads its own package.json for VERSION; next to a chunk that is this package's.
		b.onLoad({ filter: /sdk[\\/]dist[\\/]version\.js$/ }, (args) => {
			const manifest = JSON.parse(readFileSync(join(dirname(args.path), '..', 'package.json'), 'utf8'))
			return {
				contents: `export const VERSION = ${JSON.stringify(manifest.version)}\n`,
				loader: 'js',
			}
		})
	},
}

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) yield* walk(path)
		else yield path
	}
}

// Previous bundle output only: declarations (.d.ts, .d.ts.map) are tsc's and stay.
for (const path of [...walk(outDir)]) {
	if (/\.js(\.map)?$/.test(path) && !/\.d\.ts/.test(path)) rmSync(path)
}

const result = await build({
	entryPoints: entries,
	outdir: outDir,
	bundle: true,
	splitting: true,
	format: 'esm',
	platform: 'node',
	target: 'node22',
	sourcemap: true,
	sourcesContent: false,
	keepNames: true,
	external,
	chunkNames: 'chunks/[name]-[hash]',
	logLevel: 'warning',
	metafile: true,
	absWorkingDir: pkgDir,
	banner: {
		js: "import { createRequire as __namzuCreateRequire } from 'node:module';\nconst require = __namzuCreateRequire(import.meta.url);",
	},
	plugins: [importMetaUrl],
	jsx: 'automatic',
	tsconfig: join(pkgDir, 'tsconfig.json'),
	treeShaking: true,
})

// Resolve each file's dist root now that its place is known.
let rewritten = 0
for (const path of Object.keys(result.metafile.outputs)) {
	if (!path.endsWith('.js')) continue
	const file = resolve(pkgDir, path)
	const text = readFileSync(file, 'utf8')
	if (!text.includes(ROOT_TOKEN)) continue
	const depth = relative(outDir, dirname(file)).split(sep).filter(Boolean).length
	const rel = depth === 0 ? './' : '../'.repeat(depth)
	writeFileSync(
		file,
		text.replaceAll(ROOT_TOKEN, `new URL(${JSON.stringify(rel)}, import.meta.url).href`),
	)
	rewritten++
}
mkdirSync(outDir, { recursive: true })
const files = Object.keys(result.metafile.outputs).filter((p) => p.endsWith('.js')).length
process.stdout.write(`bundled ${files} files (${rewritten} resolve their dist root)\n`)
