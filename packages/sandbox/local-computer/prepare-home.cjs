const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { basename, extname, join } = require('node:path')
const { APPLICATIONS, installedApplication } = require('./app-catalog.cjs')
const { EXTENSION_ORIGIN, HOST_NAME } = require('./app-native-host.cjs')

function findIcon(name, root = '/usr/share') {
	if (name.startsWith('/')) {
		if (name.startsWith(`${root}/`) && ['.png', '.svg'].includes(extname(name)) && existsSync(name))
			return name
		// Debian can name an XPM pixmap and ship a browser-readable theme icon
		// for that same application. Copy that genuine installed asset instead.
		if (name.startsWith(`${root}/`) && extname(name) === '.xpm')
			return findIcon(basename(name, '.xpm'), root)
		return undefined
	}
	if (!/^[a-zA-Z0-9_.-]+$/.test(name)) return undefined
	for (const theme of ['hicolor', 'Adwaita']) {
		for (const size of ['128x128', '96x96', '64x64', '48x48', 'scalable', '256x256', '32x32']) {
			for (const category of ['apps', 'legacy', 'places'])
				for (const extension of ['png', 'svg']) {
					const file = join(root, 'icons', theme, size, category, `${name}.${extension}`)
					if (existsSync(file)) return file
				}
		}
	}
	for (const extension of ['svg', 'png']) {
		const file = join(root, 'pixmaps', `${name}.${extension}`)
		if (existsSync(file)) return file
	}
	return undefined
}

function desktopIcon(source) {
	let entry = false
	for (const line of source.split(/\r?\n/)) {
		if (line.startsWith('[')) entry = line === '[Desktop Entry]'
		if (entry && line.startsWith('Icon=')) return line.slice(5).trim()
	}
	return undefined
}

function prepareHome(options = {}) {
	const root = options.shareRoot ?? '/usr/share'
	const destination = options.destination ?? join(__dirname, 'new-tab')
	const applicationExists = options.applicationExists ?? ((app) => installedApplication(app.id))
	const catalogue = []
	mkdirSync(join(destination, 'icons'), { recursive: true })
	for (const app of APPLICATIONS) {
		if (!applicationExists(app)) {
			throw new Error(`Required guest application is missing: ${app.id}`)
		}
		const desktop = app.desktop.map((name) => join(root, 'applications', name)).find(existsSync)
		if (!desktop) throw new Error(`Installed guest application entry is missing: ${app.id}`)
		const iconName = desktopIcon(readFileSync(desktop, 'utf8'))
		const icon =
			(iconName && findIcon(iconName, root)) ||
			(app.fallbackIcon && findIcon(app.fallbackIcon, root))
		if (!icon) throw new Error(`Installed guest application icon is missing: ${app.id}`)
		const path = `icons/${app.id}${extname(icon)}`
		copyFileSync(icon, join(destination, path))
		catalogue.push({ id: app.id, name: app.name, icon: path })
	}
	writeFileSync(join(destination, 'apps.json'), JSON.stringify(catalogue))
	return catalogue
}

function installNativeManifest() {
	const directory = '/etc/chromium/native-messaging-hosts'
	mkdirSync(directory, { recursive: true })
	writeFileSync(
		join(directory, `${HOST_NAME}.json`),
		JSON.stringify({
			name: HOST_NAME,
			description: 'Launch installed applications in this Pal guest',
			path: '/opt/namzu-computer/app-native-host.cjs',
			type: 'stdio',
			allowed_origins: [EXTENSION_ORIGIN],
		}),
	)
}

module.exports = { findIcon, desktopIcon, prepareHome }
if (require.main === module) {
	prepareHome()
	installNativeManifest()
}
