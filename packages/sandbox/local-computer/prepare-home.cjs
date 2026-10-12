const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { basename, dirname, extname, join } = require('node:path')
const { STAGES, applicationsForStage, installedApplication } = require('./app-catalog.cjs')
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
	const stage = options.stage ?? STAGES[STAGES.length - 1]
	const applications = applicationsForStage(stage)
	const applicationExists =
		options.applicationExists ?? ((app) => installedApplication(app.id, undefined, applications))
	const catalogue = []
	mkdirSync(join(destination, 'icons'), { recursive: true })
	for (const app of applications) {
		if (!applicationExists(app)) {
			throw new Error(`Required guest application is missing: ${app.id}`)
		}
		const desktop = app.desktop.map((name) => join(root, 'applications', name)).find(existsSync)
		if (!desktop) throw new Error(`Installed guest application entry is missing: ${app.id}`)
		// A catalogue icon wins over the desktop entry's (the entry may name a plain pixmap).
		const entryIcon = desktopIcon(readFileSync(desktop, 'utf8'))
		const icon =
			(app.icon && findIcon(app.icon, root)) ||
			(entryIcon && findIcon(entryIcon, root)) ||
			(app.fallbackIcon && findIcon(app.fallbackIcon, root))
		if (!icon) throw new Error(`Installed guest application icon is missing: ${app.id}`)
		const path = `icons/${app.id}${extname(icon)}`
		copyFileSync(icon, join(destination, path))
		catalogue.push({ id: app.id, name: app.name, icon: path })
	}
	writeFileSync(join(destination, 'apps.json'), JSON.stringify(catalogue))
	// Runtime readers (the browser launcher, the native host) trust this marker, not a list of their own.
	writeFileSync(options.stageFile ?? join(dirname(destination), 'stage'), `${stage}\n`)
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

// Managed policy, so the guest browser never offers to sign in to a browser account. BrowserSignin
// alone leaves the toolbar's "Sign in to Chromium?" button; with the promotions off it is gone.
const BROWSER_POLICY = Object.freeze({
	BrowserSignin: 0,
	SyncDisabled: true,
	PromotionsEnabled: false,
})

function installBrowserPolicy(directory = '/etc/chromium/policies/managed') {
	mkdirSync(directory, { recursive: true })
	writeFileSync(join(directory, 'namzu.json'), JSON.stringify(BROWSER_POLICY))
}

function stageArgument(argv) {
	const index = argv.indexOf('--stage')
	const stage = index < 0 ? STAGES[STAGES.length - 1] : argv[index + 1]
	if (!STAGES.includes(stage)) throw new Error(`Unknown image stage: ${stage}`)
	return stage
}

module.exports = {
	findIcon,
	desktopIcon,
	prepareHome,
	installBrowserPolicy,
	stageArgument,
	BROWSER_POLICY,
}
if (require.main === module) {
	prepareHome({ stage: stageArgument(process.argv.slice(2)) })
	installNativeManifest()
	installBrowserPolicy()
}
