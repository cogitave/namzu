import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { prepareHome, desktopIcon, findIcon } = require('../../../local-computer/prepare-home.cjs')
const { APPLICATIONS } = require('../../../local-computer/app-catalog.cjs')
type Application = { id: string }

// Names observed in the installed Bookworm image, independent of catalogue
// candidates. In particular, KiCad does not install kicad.desktop.
const bookwormEntries = [
	['blender', 'blender.desktop', 'blender'],
	['freecad', 'org.freecadweb.FreeCAD.desktop', 'org.freecadweb.FreeCAD'],
	['gimp', 'gimp.desktop', 'gimp'],
	['inkscape', 'org.inkscape.Inkscape.desktop', 'org.inkscape.Inkscape'],
	['draw', 'libreoffice-draw.desktop', 'libreoffice-draw'],
	['editor', 'org.xfce.mousepad.desktop', 'org.xfce.mousepad'],
	['files', 'pcmanfm.desktop', 'system-file-manager'],
	['terminal', 'debian-xterm.desktop', 'mini.xterm'],
	['openscad', 'openscad.desktop', 'openscad'],
	['kdenlive', 'org.kde.kdenlive.desktop', 'kdenlive'],
	['godot', 'godot3.desktop', 'godot'],
	['solitaire', 'sol.desktop', 'gnome-aisleriot'],
	['qgis', 'org.qgis.qgis.desktop', 'qgis'],
	['kicad', 'org.kicad.kicad.desktop', 'kicad'],
	['paraview', 'paraview.desktop', 'paraview'],
] as const

describe('installed guest application catalogue', () => {
	it('resolves installed Bookworm desktop-entry names and copies all fifteen icons', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'namzu-home-catalogue-'))
		try {
			const shareRoot = join(directory, 'share')
			const destination = join(directory, 'extension')
			await mkdir(join(shareRoot, 'applications'), { recursive: true })
			await mkdir(join(shareRoot, 'icons/hicolor/48x48/apps'), { recursive: true })
			const required = APPLICATIONS as Application[]
			for (const [id, desktop, icon] of bookwormEntries) {
				await writeFile(
					join(shareRoot, 'applications', desktop),
					`[Desktop Entry]\nName=${id}\nIcon=${icon}\nExec=ignored-command-from-desktop\n`,
				)
				await writeFile(
					join(shareRoot, 'icons/hicolor/48x48/apps', `${icon}.svg`),
					`<svg data-installed-icon="${id}"/>`,
				)
			}
			const catalogue = prepareHome({
				shareRoot,
				destination,
				applicationExists: () => true,
			}) as { id: string; icon: string }[]
			expect(catalogue.map((app) => app.id)).toEqual(required.map((app) => app.id))
			expect(catalogue).toHaveLength(15)
			expect(catalogue.some((app) => app.id === 'qgis')).toBe(true)
			for (const app of catalogue)
				expect(await readFile(join(destination, app.icon), 'utf8')).toBe(
					`<svg data-installed-icon="${app.id}"/>`,
				)
			expect(JSON.parse(await readFile(join(destination, 'apps.json'), 'utf8'))).toEqual(catalogue)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})
	it('refuses a build that would advertise a missing required application or icon', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'namzu-home-missing-'))
		try {
			const shareRoot = join(directory, 'share')
			const destination = join(directory, 'extension')
			expect(() => prepareHome({ shareRoot, destination, applicationExists: () => false })).toThrow(
				'Required guest application is missing: blender',
			)
			await mkdir(join(shareRoot, 'applications'), { recursive: true })
			await writeFile(
				join(shareRoot, 'applications/blender.desktop'),
				'[Desktop Entry]\nIcon=blender\n',
			)
			expect(() => prepareHome({ shareRoot, destination, applicationExists: () => true })).toThrow(
				'Installed guest application icon is missing: blender',
			)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})
	it('reads only the Desktop Entry icon, rejecting path traversal and foreign absolute assets', () => {
		expect(
			desktopIcon(
				'[Other]\nIcon=wrong\n[Desktop Entry]\nIcon=blender\n[Desktop Action edit]\nIcon=other',
			),
		).toBe('blender')
		expect(findIcon('../../private/icon')).toBeUndefined()
		expect(findIcon('/home/namzu/private/icon.svg')).toBeUndefined()
	})
})
