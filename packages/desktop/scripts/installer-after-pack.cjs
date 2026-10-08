// electron-builder never copies a node_modules folder through extraResources, so the CLI's
// dependencies are put beside it here, before the installer is built from the unpacked app.
const { cpSync, existsSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
	const from = join(context.packager.projectDir, 'extra', 'cli', 'node_modules')
	const to = join(context.appOutDir, 'resources', 'cli', 'node_modules')
	if (!existsSync(from)) throw new Error(`The staged CLI has no node_modules at ${from}.`)
	cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true })
	// electron-updater reads resources/app-update.yml for its cache folder name even when the feed is
	// set at run time (a build with `publish: null` writes no such file, and the download then fails
	// with ENOENT). No provider is declared, so an installed build with no feed stays disabled.
	writeFileSync(
		join(context.appOutDir, 'resources', 'app-update.yml'),
		'updaterCacheDirName: namzu-updater\n',
	)
}
