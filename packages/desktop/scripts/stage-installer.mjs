// Assemble the flat project that electron-builder packages into the Windows installer.
//
//   node scripts/stage-installer.mjs <out-dir> [--python-archive <file.tar.gz>]
//                                    [--pal-computer-image <file> [--pal-computer-manifest <file>]]
//
// <out-dir> receives: build/ (the app icon), package.json (generated from this package, same version), dist/ (the built
// desktop), node_modules/ (the main process's runtime dependencies), electron-builder.yml,
// extra/cli (the CLI and its dependencies as a flat, real-file node_modules: no links, no absolute
// paths), extra/python (a standalone CPython with venv and pip, for local speech) and
// extra/pal-computer (the Pal computer image archive and its manifest, from
// packages/sandbox/local-computer/build-image.mjs; the archive is stored as given, never recompressed).
// Nothing is written inside the repository. Run `pnpm -r build` first.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
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
const RUNTIME_DEPENDENCIES = ['electron-updater', 'ignore', 'sherpa-onnx-node', 'ws', 'yaml']

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

/** Arguments of this script. Pure, so the flags are tested without staging anything. */
export function parseArguments(args) {
	const options = {
		out: undefined,
		pythonArchive: undefined,
		palComputerImage: undefined,
		palComputerManifest: undefined,
	}
	const flags = {
		'--python-archive': 'pythonArchive',
		'--pal-computer-image': 'palComputerImage',
		'--pal-computer-manifest': 'palComputerManifest',
	}
	const positional = []
	for (let index = 0; index < args.length; index += 1) {
		const key = flags[args[index]]
		if (!key) {
			positional.push(args[index])
			continue
		}
		const value = args[index + 1]
		if (value === undefined || value.startsWith('--')) throw new Error(`${args[index]} needs a file.`)
		options[key] = resolve(value)
		index += 1
	}
	if (positional.length !== 1)
		throw new Error(
			'Usage: stage-installer.mjs <out-dir> [--python-archive <file>] [--pal-computer-image <file> [--pal-computer-manifest <file>]]',
		)
	if (options.palComputerManifest && !options.palComputerImage)
		throw new Error('--pal-computer-manifest needs --pal-computer-image.')
	options.out = resolve(positional[0])
	if (options.palComputerImage && !options.palComputerManifest)
		options.palComputerManifest = join(dirname(options.palComputerImage), 'manifest.json')
	return options
}

/** The reference the Pal computer provider is told to run; anything else is a test build. */
const PAL_IMAGE_REF = /^namzu-local-computer:\d+(-[A-Za-z0-9._]+)?$/

const MANIFEST_KEYS = [
	'revision',
	'imageRef',
	'imageId',
	'protocol',
	'sha256',
	'sizeBytes',
	'compressedBytes',
	'format',
	'file',
]

/**
 * Copy the Pal computer image archive and its manifest into <out>/extra/pal-computer, after
 * checking the manifest describes this very archive (name, size and SHA-256). The archive is
 * already compressed and is copied byte for byte; the installer carries the image so a Pal's
 * computer never needs a download.
 */
export function stagePalComputer(out, imageFile, manifestFile) {
	const target = join(out, 'extra/pal-computer')
	mkdirSync(target, { recursive: true })
	if (!imageFile) {
		writeFileSync(
			join(target, 'README.txt'),
			'This build carries no Pal computer image (stage-installer ran without --pal-computer-image).\n',
		)
		return undefined
	}
	if (!existsSync(imageFile)) throw new Error(`${imageFile} does not exist.`)
	if (!existsSync(manifestFile)) throw new Error(`${manifestFile} does not exist.`)
	const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
	for (const key of MANIFEST_KEYS)
		if (manifest[key] === undefined) throw new Error(`The Pal computer manifest has no "${key}".`)
	if (!PAL_IMAGE_REF.test(manifest.imageRef))
		throw new Error(
			`The Pal computer manifest names the image ${manifest.imageRef}; an installer carries only namzu-local-computer:<revision> (a test tag such as namzu-t2-base:2 is never bundled).`,
		)
	if (manifest.file !== basename(imageFile))
		throw new Error(`The manifest describes ${manifest.file}, not ${basename(imageFile)}.`)
	if (statSync(imageFile).size !== manifest.compressedBytes)
		throw new Error(`${basename(imageFile)} is not ${manifest.compressedBytes} bytes, as its manifest says.`)
	if (sha256(imageFile) !== manifest.sha256)
		throw new Error(`${basename(imageFile)} does not match the manifest sha256 ${manifest.sha256}.`)
	copyFileSync(imageFile, join(target, manifest.file))
	copyFileSync(manifestFile, join(target, 'manifest.json'))
	return manifest
}

async function main() {
	const {
		out,
		pythonArchive: explicitArchive,
		palComputerImage,
		palComputerManifest,
	} = parseArguments(process.argv.slice(2))
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
	// The installer is Windows x64 whatever machine stages it, so the platform-specific optional
	// packages (the speech engine's native addon) are chosen for it, not for this host.
	run(
		'npm',
		[
			'install',
			'--omit=dev',
			'--ignore-scripts',
			'--no-audit',
			'--no-fund',
			'--no-package-lock',
			'--os=win32',
			'--cpu=x64',
		],
		{ cwd: out },
	)
	if (!existsSync(join(out, 'node_modules/sherpa-onnx-win-x64/sherpa-onnx.node')))
		throw new Error('The staged app has no sherpa-onnx win-x64 addon; local listening would not work.')

	prune(join(out, 'node_modules'), (entry) => entry.name === '.bin')

	// 2. The CLI runtime: a hoisted, link-free production install of the workspace package.
	const cli = join(out, 'extra/cli')
	run('pnpm', ['--filter', '@namzu/cli', 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', cli], {
		cwd: repoRoot,
	})
	prune(cli, (entry) => entry.name === '.bin' || entry.isSymbolicLink())
	// Terminals need node-pty, an optional dependency of the CLI that a deploy on a machine without a
	// compiler can silently omit. The Windows binaries ship inside the package, so check for them here
	// rather than finding an installer whose terminals are all unavailable.
	if (!existsSync(join(cli, 'node_modules/node-pty/prebuilds/win32-x64/pty.node')))
		throw new Error('The staged CLI runtime has no node-pty win32-x64 binary; terminals would not work.')

	// 3. The Pal computer image, when this build carries one.
	const palComputer = stagePalComputer(out, palComputerImage, palComputerManifest)

	// 4. Python.
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
	// Measured before the scratch folder goes: a downloaded archive lives inside it.
	const archiveMb = (statSync(archive).size / 1e6).toFixed(1)
	rmSync(scratch, { recursive: true, force: true })

	const imageMb = palComputer
		? `; pal computer image ${(palComputer.compressedBytes / 1e6).toFixed(1)} MB`
		: ''
	console.log(`Staged ${out} (version ${desktop.version}); python archive ${archiveMb} MB${imageMb}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
