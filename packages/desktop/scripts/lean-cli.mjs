// What the installer ships of the CLI's node_modules: the packages the bundle leaves external, the
// closure of what they depend on, and only the native binaries of the platform the installer is
// built for. Everything else in a `pnpm deploy` tree is code the esbuild bundle already inlined, so
// it is never loaded and is not shipped.
//
// The list of externals is packages/cli/scripts/externals.mjs, the file bundle.mjs hands to esbuild.
// Nothing here copies a package name out of it.
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The platform an installer is built for, as Node names it: `{ platform: 'win32', arch: 'x64' }`.
 * A Linux target also names its C library: `linux-x64` is glibc, `linux-x64-musl` is musl. Only
 * Linux has the choice, so a suffix on another platform is refused.
 */
export function parseTarget(text) {
	const match = /^(win32|darwin|linux)-(x64|arm64|ia32)(?:-(glibc|musl))?$/.exec(text ?? '')
	if (!match || (match[3] && match[1] !== 'linux'))
		throw new Error(
			`--target must look like win32-x64, darwin-arm64, linux-x64 or linux-x64-musl, not "${text}".`,
		)
	return match[1] === 'linux'
		? { platform: match[1], arch: match[2], libc: match[3] ?? 'glibc' }
		: { platform: match[1], arch: match[2] }
}

/** The externals the bundle declares, read from the CLI package's own list. */
export async function loadExternals(cliPackageDir) {
	const file = join(cliPackageDir, 'scripts', 'externals.mjs')
	const { external } = await import(pathToFileURL(file).href)
	if (!Array.isArray(external) || external.length === 0)
		throw new Error(`${file} exports no "external" list.`)
	return external
}

/** `@scope/name/sub/path` and `name/sub` are the package `@scope/name` and `name`. */
export function packageNameOf(specifier) {
	const parts = specifier.split('/')
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))
/** A specifier that names a package: not a relative or absolute path, not a Node built-in. */
export function isPackageSpecifier(specifier) {
	if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(specifier))
		return false
	if (specifier.startsWith('node:') || specifier.startsWith('data:') || specifier.startsWith('file:')) return false
	if (BUILTINS.has(specifier) || BUILTINS.has(specifier.split('/')[0])) return false
	return /^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(\/|$)/i.test(specifier)
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/**
 * Does a package apply to this platform? Platform packages (the sharp, oxc-parser and node-pty
 * bindings, the speech engine's addon) say so in the `os`, `cpu` and `libc` fields of their
 * manifest, the same fields a package manager reads. A package that sets none is for everyone.
 * `libc` only means something on Linux, so a Windows or macOS target never matches a libc-specific
 * package and a package that sets only `libc` is a Linux one. A Linux target that names its `libc`
 * (`parseTarget` always does) matches only the packages for that library, so the musl build of a
 * binding is not kept for a glibc target; a target that names none matches both.
 */
export function appliesToTarget(manifest, target) {
	const accepts = (list, value) => {
		if (!Array.isArray(list) || list.length === 0) return true
		const allowed = list.filter((entry) => !entry.startsWith('!'))
		const denied = list.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1))
		if (denied.includes(value)) return false
		return allowed.length === 0 || allowed.includes(value)
	}
	if (!accepts(manifest.os, target.platform) || !accepts(manifest.cpu, target.arch)) return false
	if (Array.isArray(manifest.libc) && manifest.libc.length > 0) {
		if (target.platform !== 'linux') return false
		if (target.libc && !accepts(manifest.libc, target.libc)) return false
	}
	return true
}

/** Does a package's manifest restrict it to some platforms at all? */
export function isPlatformPackage(manifest) {
	return ['os', 'cpu', 'libc'].some((key) => Array.isArray(manifest[key]) && manifest[key].length > 0)
}

/**
 * Is a directory inside a package's `prebuilds` the binaries of a platform other than the target?
 * Names look like `win32-x64`, `darwin-arm64`, `linux-x64` and `linuxmusl-arm64`. A name that is
 * not a platform (a bare `universal` folder, say) is not judged here and is kept.
 */
export function isForeignPrebuild(directoryName, target) {
	const match = /^(win32|darwin|linux|linuxmusl|freebsd|android|openbsd)-(x64|arm64|ia32|arm|armv7l|ppc64|s390x|riscv64|loong64)(?:[-.].*)?$/.exec(
		directoryName,
	)
	if (!match) return false
	const platform = target.platform === 'linux' && target.libc === 'musl' ? 'linuxmusl' : target.platform
	return !(match[1] === platform && match[2] === target.arch)
}

/** Find a package named `name` the way Node would from `fromDir`, never above `root`. */
export function findPackage(name, fromDir, root) {
	let dir = fromDir
	for (;;) {
		const candidate = join(dir, 'node_modules', name)
		if (existsSync(join(candidate, 'package.json'))) return candidate
		if (dir === root || dirname(dir) === dir) return undefined
		dir = dirname(dir)
	}
}

/**
 * Externals that are meant to be absent from a deploy, each with the reason. Any other external
 * missing from the deployed tree stops the staging: the bundle would import something the
 * installer does not carry.
 */
export const NOT_SHIPPED = {
	'react-devtools-core': 'a development-only import of the terminal UI library, behind DEV=true',
	'@namzu/telemetry': 'an optional package: the CLI treats its absence as telemetry being off',
}

/**
 * The directories of node_modules that must stay: each external and the closure of its
 * `dependencies`, `optionalDependencies` and `peerDependencies`, minus packages built for another
 * platform. A dependency or peer that is absent from the tree is skipped (an optional one is meant
 * to be, a platform one is for another machine); an external that is absent stops the staging.
 *
 * `root` is the deployed CLI (the folder holding package.json and node_modules). Returns the kept
 * directories and a line of "why" per top-level external and per package pulled in by another.
 */
export function deriveKeepSet({ externals, root, target }) {
	const manifest = readJson(join(root, 'package.json'))
	const declared = new Set([
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.optionalDependencies ?? {}),
	])
	const keep = new Map() // directory -> why
	const skippedForTarget = []
	const queue = []
	const missing = []
	const enqueue = (name, fromDir, why, required) => {
		const dir = findPackage(name, fromDir, root)
		if (!dir) {
			if (required) missing.push(name)
			return
		}
		if (keep.has(dir)) return
		const meta = readJson(join(dir, 'package.json'))
		if (!appliesToTarget(meta, target)) {
			skippedForTarget.push(name)
			return
		}
		keep.set(dir, why)
		queue.push(dir)
	}
	for (const name of externals) {
		if (!findPackage(name, root, root)) {
			if (declared.has(name)) missing.push(name)
			else if (!(name in NOT_SHIPPED))
				throw new Error(
					`The bundle leaves "${name}" external, but the deployed CLI has no such package and does not declare it. Add it to the CLI's dependencies, or to NOT_SHIPPED in lean-cli.mjs with the reason it may be absent.`,
				)
			continue
		}
		enqueue(name, root, 'external of the bundle', true)
	}
	if (missing.length > 0)
		throw new Error(
			`The bundle leaves ${missing.map((name) => `"${name}"`).join(', ')} external and the CLI depends on it, but the deployed tree has no such package.`,
		)
	while (queue.length > 0) {
		const dir = queue.shift()
		const meta = readJson(join(dir, 'package.json'))
		for (const name of Object.keys(meta.dependencies ?? {}))
			enqueue(name, dir, `needed by ${meta.name}`, true)
		for (const name of Object.keys(meta.optionalDependencies ?? {}))
			enqueue(name, dir, `optional of ${meta.name}`, false)
		for (const name of Object.keys(meta.peerDependencies ?? {}))
			enqueue(name, dir, `peer of ${meta.name}`, false)
	}
	if (missing.length > 0)
		throw new Error(
			`A kept package depends on ${[...new Set(missing)].map((name) => `"${name}"`).join(', ')}, which the deployed tree does not have.`,
		)
	return { keep, skippedForTarget }
}

const LICENCE_FILE = /^(licen[sc]e|notice|copying|authors?|patents)([-_.].*)?$/i

function* packageDirs(nodeModules) {
	if (!existsSync(nodeModules)) return
	for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === '.bin') continue
		const path = join(nodeModules, entry.name)
		if (entry.name.startsWith('@')) {
			for (const inner of readdirSync(path, { withFileTypes: true }))
				if (inner.isDirectory()) yield join(path, inner.name)
		} else yield path
	}
}

/**
 * Delete every package under `root/node_modules` that is not in `keep`, nested ones included, and
 * return the licence text of what was removed: the bundle inlines the code of most of those
 * packages, so their licences and notices are written into one file the installer carries.
 */
export function pruneToKeepSet(root, keep) {
	const removed = []
	const licences = []
	const visit = (nodeModules) => {
		for (const dir of [...packageDirs(nodeModules)]) {
			if (keep.has(dir)) {
				visit(join(dir, 'node_modules'))
				continue
			}
			const manifestFile = join(dir, 'package.json')
			const meta = existsSync(manifestFile) ? readJson(manifestFile) : { name: relative(nodeModules, dir) }
			const texts = []
			for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [])
				if (entry.isFile() && LICENCE_FILE.test(entry.name))
					texts.push({ file: entry.name, text: readFileSync(join(dir, entry.name), 'utf8') })
			licences.push({ name: meta.name ?? relative(nodeModules, dir), version: meta.version, licence: meta.license, texts })
			removed.push(dir)
			rmSync(dir, { recursive: true, force: true })
		}
	}
	visit(join(root, 'node_modules'))
	return { removed, licences }
}

/** The licence file the installer carries for the packages whose code the bundle inlined. */
export function renderBundledLicences(licences) {
	const sorted = [...licences].sort((a, b) => a.name.localeCompare(b.name))
	const head =
		'Licences and notices of the packages whose code is compiled into the CLI bundle (dist/).\nThe packages themselves are not shipped; their licence texts are kept here.\n'
	const body = sorted
		.map((entry) => {
			const title = `${entry.name}${entry.version ? `@${entry.version}` : ''}${entry.licence ? ` (${typeof entry.licence === 'string' ? entry.licence : (entry.licence.type ?? 'see text')})` : ''}`
			const texts = entry.texts.length
				? entry.texts.map((t) => `--- ${t.file}\n${t.text.trimEnd()}`).join('\n')
				: '(this package carries no licence file; see its package.json licence field above)'
			return `\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}\n${texts}\n`
		})
		.join('')
	return head + body
}

/**
 * Inside the kept packages, remove the prebuilt binaries of other platforms: any directory named
 * for a platform and architecture under a `prebuilds` folder. Returns how many directories went.
 */
export function pruneForeignPrebuilds(root, target) {
	let removed = 0
	const visit = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue
			const path = join(dir, entry.name)
			if (entry.name === 'prebuilds') {
				for (const inner of readdirSync(path, { withFileTypes: true })) {
					if (inner.isDirectory() && isForeignPrebuild(inner.name, target)) {
						rmSync(join(path, inner.name), { recursive: true, force: true })
						removed += 1
					}
				}
			} else visit(path)
		}
	}
	visit(join(root, 'node_modules'))
	return removed
}

/** Every file of a folder, recursively, as paths relative to it with `/` separators. */
export function listFiles(dir) {
	const out = []
	const visit = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name)
			if (entry.isDirectory()) visit(path)
			else out.push(relative(dir, path).split(sep).join('/'))
		}
	}
	if (existsSync(dir)) visit(dir)
	return out
}

export function measure(dir) {
	let bytes = 0
	const files = listFiles(dir)
	for (const file of files) bytes += statSync(join(dir, file)).size
	return { files: files.length, bytes }
}

/**
 * Make the deployed CLI lean: keep the externals' closure for the target, drop the rest, drop
 * foreign prebuilds, and leave the licences of what was inlined in THIRD-PARTY-LICENSES.txt.
 */
export function leanCli({ root, externals, target }) {
	const { keep, skippedForTarget } = deriveKeepSet({ externals, root, target })
	const { removed, licences } = pruneToKeepSet(root, keep)
	const foreign = pruneForeignPrebuilds(root, target)
	writeFileSync(join(root, 'THIRD-PARTY-LICENSES.txt'), renderBundledLicences(licences))
	return { keep, removedPackages: removed.length, skippedForTarget, foreignPrebuilds: foreign }
}
