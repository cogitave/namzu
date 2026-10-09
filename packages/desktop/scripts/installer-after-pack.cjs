// electron-builder never copies a node_modules folder through extraResources, so the CLI's
// dependencies are put beside it here, before the installer is built from the unpacked app.
const { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

// electron-builder's Arch enum, as `context.arch` reports it.
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

/**
 * The pseudo-terminal binding is shipped as the Windows binaries it already carries and
 * nothing else. It lives in the CLI runtime under resources/cli, which is outside
 * the app archive, so its native files load as they are and no unpacking is needed.
 * What is removed: the other platforms' prebuilds, every debug-symbol file (about 30 MB
 * on win32-x64), a build tree a Linux staging machine may have left behind (the loader
 * tries it before the prebuilds), and the sources and headers only a compiler reads.
 */
function stripNodePty(dir, target) {
	if (!existsSync(dir)) return false
	const keep = `${target.platform}-${target.arch}`
	const prebuilds = join(dir, 'prebuilds')
	if (existsSync(prebuilds)) {
		if (!existsSync(join(prebuilds, keep)))
			throw new Error(`node-pty has no prebuilt binary for ${keep}.`)
		for (const entry of readdirSync(prebuilds)) {
			if (entry !== keep) rmSync(join(prebuilds, entry), { recursive: true, force: true })
		}
	}
	for (const name of ['build', 'src', 'deps', 'third_party', 'scripts', 'binding.gyp'])
		rmSync(join(dir, name), { recursive: true, force: true })
	// The compiler's headers, which a deploy may leave beside the package under a versioned name.
	for (const entry of readdirSync(dir))
		if (entry.startsWith('node-addon-api')) rmSync(join(dir, entry), { recursive: true, force: true })
	const removePdb = (folder) => {
		for (const entry of readdirSync(folder, { withFileTypes: true })) {
			const path = join(folder, entry.name)
			if (entry.isDirectory()) removePdb(path)
			else if (entry.name.endsWith('.pdb')) rmSync(path, { force: true })
		}
	}
	removePdb(dir)
	return true
}
exports.stripNodePty = stripNodePty

/**
 * electron-updater reads resources/app-update.yml for its feed and for its cache folder name.
 * electron-builder writes that file from the `publish` block of electron-builder.yml in its own
 * after-pack handler, which runs BEFORE this hook, so the file is kept as written (provider, url,
 * range-request setting) and only the cache folder name is set. Only a build with `publish: null`
 * writes no file; then a cache-only file is written (without it the download fails with ENOENT)
 * and, with no provider declared, an installed build with no feed stays disabled.
 * The file is flat `key: value` lines, so a line edit is enough and no YAML library is needed.
 */
function writeAppUpdateYml(file) {
	const line = 'updaterCacheDirName: namzu-updater'
	if (!existsSync(file)) {
		writeFileSync(file, `${line}\n`)
		return
	}
	const lines = readFileSync(file, 'utf8')
		.split(/\r?\n/)
		.filter((l, i, all) => l !== '' || i < all.length - 1)
	const at = lines.findIndex((l) => /^updaterCacheDirName\s*:/.test(l))
	if (at >= 0) lines[at] = line
	else lines.push(line)
	writeFileSync(file, `${lines.join('\n')}\n`)
}
exports.writeAppUpdateYml = writeAppUpdateYml

exports.default = async function afterPack(context) {
	const from = join(context.packager.projectDir, 'extra', 'cli', 'node_modules')
	const to = join(context.appOutDir, 'resources', 'cli', 'node_modules')
	if (!existsSync(from)) throw new Error(`The staged CLI has no node_modules at ${from}.`)
	cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true })
	// node-pty is an optional dependency of the CLI: a missing one only turns terminals off, but an
	// installer for this platform carries it, so its absence is a packaging mistake worth failing on.
	const arch = ARCH_NAMES[context.arch] ?? process.arch
	if (!stripNodePty(join(to, 'node-pty'), { platform: context.electronPlatformName, arch }))
		throw new Error(`The staged CLI has no node-pty at ${join(to, 'node-pty')}; terminals would be unavailable.`)
	rmSync(join(to, 'node-addon-api'), { recursive: true, force: true })
	writeAppUpdateYml(join(context.appOutDir, 'resources', 'app-update.yml'))
}
