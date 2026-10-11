const { constants, accessSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

// The image is built in stages and each stage advertises only what it installed.
// `base` is the light Pal computer; `creative` is built FROM it and adds the heavy
// applications, so its catalogue is every application of both stages.
const STAGES = Object.freeze(['base', 'creative'])

// Application ids never become commands, paths, argv or environment variables.
// Each stage installs its own entries and fails its build if an executable
// or icon is absent. No id is advertised as a simulated application.
const APPLICATIONS = Object.freeze(
	[
		{
			id: 'blender',
			stage: 'creative',
			name: 'Blender',
			binary: '/usr/local/bin/blender',
			args: [],
			desktop: ['blender.desktop'],
			software: true,
			required: true,
		},
		{
			id: 'freecad',
			stage: 'creative',
			name: 'FreeCAD',
			binary: '/usr/bin/freecad',
			args: [],
			desktop: ['org.freecadweb.FreeCAD.desktop', 'freecad.desktop'],
			software: true,
			required: true,
		},
		{
			id: 'gimp',
			stage: 'creative',
			name: 'GIMP',
			binary: '/usr/bin/gimp',
			args: [],
			desktop: ['gimp.desktop'],
			required: true,
		},
		{
			id: 'inkscape',
			stage: 'creative',
			name: 'Inkscape',
			binary: '/usr/bin/inkscape',
			args: [],
			desktop: ['org.inkscape.Inkscape.desktop', 'inkscape.desktop'],
			required: true,
		},
		{
			id: 'draw',
			stage: 'creative',
			name: 'LibreOffice Draw',
			binary: '/usr/bin/libreoffice',
			args: ['--draw'],
			desktop: ['libreoffice-draw.desktop'],
			required: true,
		},
		{
			id: 'editor',
			stage: 'base',
			name: 'Text Editor',
			binary: '/usr/bin/mousepad',
			args: [],
			desktop: ['org.xfce.mousepad.desktop', 'mousepad.desktop'],
			required: true,
		},
		{
			id: 'files',
			stage: 'base',
			name: 'Files',
			binary: '/usr/bin/pcmanfm',
			args: ['/home/namzu/workspace'],
			desktop: ['pcmanfm.desktop'],
			required: true,
		},
		{
			id: 'terminal',
			stage: 'base',
			name: 'Terminal',
			binary: '/usr/bin/xterm',
			args: [
				'-fa',
				'DejaVu Sans Mono',
				'-fs',
				'11',
				'-bg',
				'#171c18',
				'-fg',
				'#e7eee8',
				'-cr',
				'#76d77d',
				'-title',
				'Terminal',
			],
			desktop: ['debian-xterm.desktop', 'xterm.desktop'],
			// The dock's own terminal glyph, not the plain xterm pixmap.
			icon: 'utilities-terminal',
			required: true,
		},
		{
			id: 'openscad',
			stage: 'creative',
			name: 'OpenSCAD',
			binary: '/usr/bin/openscad',
			args: [],
			desktop: ['openscad.desktop'],
			software: true,
		},
		{
			id: 'kdenlive',
			stage: 'creative',
			name: 'Kdenlive',
			binary: '/usr/bin/kdenlive',
			args: [],
			desktop: ['org.kde.kdenlive.desktop', 'kdenlive.desktop'],
			software: true,
		},
		{
			id: 'godot',
			stage: 'creative',
			name: 'Godot',
			binary: '/usr/local/bin/godot4',
			args: ['--rendering-method', 'gl_compatibility'],
			desktop: ['godot3.desktop'],
			software: true,
		},
		{
			id: 'solitaire',
			stage: 'creative',
			name: 'Solitaire',
			binary: '/usr/games/sol',
			args: [],
			desktop: ['sol.desktop', 'org.gnome.Aisleriot.desktop', 'aisleriot.desktop'],
		},
		{
			id: 'qgis',
			stage: 'creative',
			name: 'QGIS',
			binary: '/usr/bin/qgis',
			args: [],
			desktop: ['org.qgis.qgis.desktop', 'qgis.desktop'],
			software: true,
		},
		{
			id: 'kicad',
			stage: 'creative',
			name: 'KiCad',
			binary: '/usr/bin/kicad',
			args: [],
			desktop: ['org.kicad.kicad.desktop', 'kicad.desktop'],
			software: true,
		},
		{
			id: 'paraview',
			stage: 'creative',
			name: 'ParaView',
			binary: '/usr/bin/paraview',
			args: [],
			desktop: ['paraview.desktop'],
			software: true,
		},
	].map((app) =>
		Object.freeze({ ...app, args: Object.freeze(app.args), desktop: Object.freeze(app.desktop) }),
	),
)

/** Applications a stage installs: its own and those of every stage it is built FROM. */
function applicationsForStage(stage) {
	const rank = STAGES.indexOf(stage)
	if (rank < 0) throw new Error(`Unknown image stage: ${stage}`)
	return APPLICATIONS.filter((app) => STAGES.indexOf(app.stage) <= rank)
}

/**
 * The stage this image was built as, written by prepare-home at build time. A tree
 * without the marker (a source checkout, a test) is the whole catalogue.
 */
function activeStage(read = () => readFileSync(join(__dirname, 'stage'), 'utf8')) {
	try {
		const stage = read().trim()
		return STAGES.includes(stage) ? stage : STAGES[STAGES.length - 1]
	} catch {
		return STAGES[STAGES.length - 1]
	}
}

function activeApplications(read) {
	return applicationsForStage(activeStage(read))
}

function installedApplication(
	id,
	access = (binary) => accessSync(binary, constants.X_OK),
	applications = activeApplications(),
) {
	const app = applications.find((entry) => entry.id === id)
	if (!app) return undefined
	try {
		access(app.binary)
		return app
	} catch {
		return undefined
	}
}

function applicationEnvironment(app, inherited = process.env) {
	const env = { ...inherited }
	for (const key of Object.keys(env))
		if (key.startsWith('NAMZU_') || key === 'NODE_OPTIONS' || key.startsWith('LD_')) delete env[key]
	// Chromium disables its own D-Bus use. Desktop applications still need the
	// guest session bus or their normal local autolaunch when no bus is set.
	if (env.DBUS_SESSION_BUS_ADDRESS === 'disabled:')
		Reflect.deleteProperty(env, 'DBUS_SESSION_BUS_ADDRESS')
	// Explicit guest-only values. No host display, profile or caller cwd is used.
	env.HOME = '/home/namzu'
	env.DISPLAY = ':99'
	env.PATH = '/usr/local/bin:/usr/bin:/bin:/usr/games'
	if (app.software) env.LIBGL_ALWAYS_SOFTWARE = '1'
	if (app.id === 'blender') {
		env.BLENDERMCP_NO_UPDATE_CHECK = '1'
		env.BLENDER_MCP_DISABLE_TELEMETRY = '1'
	}
	// The isolated guest has no host audio device. SDL must not abort the editor
	// while trying to open an unavailable ALSA default output.
	if (app.id === 'kdenlive') env.SDL_AUDIODRIVER = 'dummy'
	return env
}

module.exports = {
	APPLICATIONS,
	STAGES,
	applicationsForStage,
	activeStage,
	activeApplications,
	installedApplication,
	applicationEnvironment,
}
