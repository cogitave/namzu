const { constants, accessSync } = require('node:fs')

// Application ids never become commands, paths, argv or environment variables.
// The reference image installs every entry and fails its build if an executable
// or icon is absent. No id is advertised as a simulated application.
const APPLICATIONS = Object.freeze(
	[
		{
			id: 'blender',
			name: 'Blender',
			binary: '/usr/bin/blender',
			args: [],
			desktop: ['blender.desktop'],
			software: true,
			required: true,
		},
		{
			id: 'freecad',
			name: 'FreeCAD',
			binary: '/usr/bin/freecad',
			args: [],
			desktop: ['org.freecadweb.FreeCAD.desktop', 'freecad.desktop'],
			software: true,
			required: true,
		},
		{
			id: 'gimp',
			name: 'GIMP',
			binary: '/usr/bin/gimp',
			args: [],
			desktop: ['gimp.desktop'],
			required: true,
		},
		{
			id: 'inkscape',
			name: 'Inkscape',
			binary: '/usr/bin/inkscape',
			args: [],
			desktop: ['org.inkscape.Inkscape.desktop', 'inkscape.desktop'],
			required: true,
		},
		{
			id: 'draw',
			name: 'LibreOffice Draw',
			binary: '/usr/bin/libreoffice',
			args: ['--draw'],
			desktop: ['libreoffice-draw.desktop'],
			required: true,
		},
		{
			id: 'editor',
			name: 'Text Editor',
			binary: '/usr/bin/mousepad',
			args: [],
			desktop: ['org.xfce.mousepad.desktop', 'mousepad.desktop'],
			required: true,
		},
		{
			id: 'files',
			name: 'Files',
			binary: '/usr/bin/pcmanfm',
			args: ['/home/namzu/workspace'],
			desktop: ['pcmanfm.desktop'],
			required: true,
		},
		{
			id: 'terminal',
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
			fallbackIcon: 'utilities-terminal',
			required: true,
		},
		{
			id: 'openscad',
			name: 'OpenSCAD',
			binary: '/usr/bin/openscad',
			args: [],
			desktop: ['openscad.desktop'],
			software: true,
		},
		{
			id: 'kdenlive',
			name: 'Kdenlive',
			binary: '/usr/bin/kdenlive',
			args: [],
			desktop: ['org.kde.kdenlive.desktop', 'kdenlive.desktop'],
			software: true,
		},
		{
			id: 'godot',
			name: 'Godot 3',
			binary: '/usr/bin/godot3',
			args: ['--video-driver', 'GLES2'],
			desktop: ['godot3.desktop'],
			software: true,
		},
		{
			id: 'solitaire',
			name: 'Solitaire',
			binary: '/usr/games/sol',
			args: [],
			desktop: ['sol.desktop', 'org.gnome.Aisleriot.desktop', 'aisleriot.desktop'],
		},
		{
			id: 'qgis',
			name: 'QGIS',
			binary: '/usr/bin/qgis',
			args: [],
			desktop: ['org.qgis.qgis.desktop', 'qgis.desktop'],
			software: true,
		},
		{
			id: 'kicad',
			name: 'KiCad',
			binary: '/usr/bin/kicad',
			args: [],
			desktop: ['org.kicad.kicad.desktop', 'kicad.desktop'],
			software: true,
		},
		{
			id: 'paraview',
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

function installedApplication(id, access = (binary) => accessSync(binary, constants.X_OK)) {
	const app = APPLICATIONS.find((entry) => entry.id === id)
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
	// The isolated guest has no host audio device. SDL must not abort the editor
	// while trying to open an unavailable ALSA default output.
	if (app.id === 'kdenlive') env.SDL_AUDIODRIVER = 'dummy'
	return env
}

module.exports = { APPLICATIONS, installedApplication, applicationEnvironment }
