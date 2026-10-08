// Assemble the flat project that electron-builder packages into the Windows installer.
//
//   node scripts/stage-installer.mjs <out-dir> [--python-archive <file.tar.gz>]
//
// <out-dir> receives: build/ (the app icon), package.json (generated from this package, same version), dist/ (the built
// desktop), node_modules/ (the main process's runtime dependencies), electron-builder.yml,
// extra/cli (the CLI and its dependencies as a flat, real-file node_modules: no links, no absolute
// paths) and extra/python (a standalone CPython with venv and pip, for local speech).
// Nothing is written inside the repository. Run `pnpm -r build` first.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(pkgRoot, '../..')

// python-build-standalone, "install_only_stripped": CPython 3.14 with venv, pip and ssl. The
// python.org embeddable zip lacks venv and pip, which local speech needs. Pinned by hash.
export const PYTHON = {
	release: '20261003',
	version: '3.14.8',
	file: 'cpython-3.14.8+20261003-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',
	url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.14.8%2B20261003-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',
	sha256: '10e5705e44938ee78de35c62b30fdfe2945b53438343d04c0f53548cdd8e91b6',
}
const RUNTIME_DEPENDENCIES = ['electron-updater', 'ignore', 'ws', 'yaml']

const run = (program, args, options = {}) =>
	execFileSync(program, args, { stdio: 'inherit', ...options })
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

function prune(directory, remove) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name)
		if (remove(entry, path)) rmSync(path, { recursive: true, force: true })
		else if (entry.isDirectory()) prune(path, remove)
	}
}

async function pythonArchive(explicit, scratch) {
	const file = explicit ?? join(scratch, PYTHON.file)
	if (!existsSync(file)) {
		const response = await fetch(PYTHON.url)
		if (!response.ok) throw new Error(`Python download failed: ${response.status}`)
		writeFileSync(file, Buffer.from(await response.arrayBuffer()))
	}
	if (sha256(file) !== PYTHON.sha256)
		throw new Error(`${file} does not match the pinned sha256 ${PYTHON.sha256}.`)
	return file
}

async function main() {
	const args = process.argv.slice(2)
	const archiveFlag = args.indexOf('--python-archive')
	const explicitArchive = archiveFlag === -1 ? undefined : resolve(args[archiveFlag + 1] ?? '')
	const positional = args.filter((_, index) => index !== archiveFlag && index !== archiveFlag + 1)
	if (positional.length !== 1) throw new Error('Usage: stage-installer.mjs <out-dir>')
	const out = resolve(positional[0])
	if (out === repoRoot || out.startsWith(`${repoRoot}/`) || out.startsWith(`${repoRoot}\\`))
		throw new Error('Stage outside the repository; build output does not belong in Git.')
	const desktop = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
	if (!existsSync(join(pkgRoot, 'dist/main/index.js')))
		throw new Error('Build first: pnpm -r build')
	rmSync(out, { recursive: true, force: true })
	mkdirSync(out, { recursive: true })

	// 1. The app project: package.json is generated, so its version is the package's own.
	const dependencies = Object.fromEntries(
		RUNTIME_DEPENDENCIES.map((name) => {
			const version = desktop.dependencies[name]
			if (!version) throw new Error(`${name} is not a dependency of @namzu/desktop.`)
			return [name, version]
		}),
	)
	writeFileSync(
		join(out, 'package.json'),
		`${JSON.stringify(
			{
				name: 'namzu',
				productName: 'Namzu',
				version: desktop.version,
				description: 'Namzu, the operator application for AI agents.',
				author: { name: 'Namzu Contributors' },
				homepage: 'https://namzu.ai',
				license: desktop.license,
				type: 'module',
				main: 'dist/main/index.js',
				dependencies,
			},
			null,
			2,
		)}\n`,
	)
	cpSync(join(pkgRoot, 'dist'), join(out, 'dist'), { recursive: true })
	cpSync(join(pkgRoot, 'build'), join(out, 'build'), { recursive: true })
	cpSync(join(pkgRoot, 'electron-builder.yml'), join(out, 'electron-builder.yml'))
	cpSync(join(pkgRoot, 'scripts/installer-after-pack.cjs'), join(out, 'installer-after-pack.cjs'))
	run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], {
		cwd: out,
	})

	prune(join(out, 'node_modules'), (entry) => entry.name === '.bin')

	// 2. The CLI runtime: a hoisted, link-free production install of the workspace package.
	const cli = join(out, 'extra/cli')
	run('pnpm', ['--filter', '@namzu/cli', 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', cli], {
		cwd: repoRoot,
	})
	prune(cli, (entry) => entry.name === '.bin' || entry.isSymbolicLink())

	// 3. Python.
	const scratch = join(out, '.download')
	mkdirSync(scratch)
	const archive = await pythonArchive(explicitArchive, scratch)
	const extract = join(scratch, 'x')
	mkdirSync(extract)
	run('tar', ['-xzf', archive, '-C', extract])
	cpSync(join(extract, 'python'), join(out, 'extra/python'), { recursive: true })
	writeFileSync(
		join(out, 'extra/python/PYTHON-BUILD-STANDALONE.txt'),
		`CPython ${PYTHON.version} from python-build-standalone ${PYTHON.release}\n${PYTHON.url}\nsha256 ${PYTHON.sha256}\nCPython is under the PSF License (LICENSE.txt in this folder); python-build-standalone is MPL-2.0.\n`,
	)
	rmSync(scratch, { recursive: true, force: true })

	const size = (path) => (statSync(path).size / 1e6).toFixed(1)
	console.log(`Staged ${out} (version ${desktop.version}); python archive ${size(archive)} MB`)
}

await main()
