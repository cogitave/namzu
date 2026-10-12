import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const catalogue = require('../../../local-computer/app-catalog.cjs')
const {
	prepareHome,
	installBrowserPolicy,
	stageArgument,
	BROWSER_POLICY,
} = require('../../../local-computer/prepare-home.cjs')
type App = { id: string; stage: string }

const baseIds = ['editor', 'files', 'terminal']

async function shareRoot(
	directory: string,
	apps: readonly { id: string; desktop: readonly string[] }[],
) {
	const root = join(directory, 'share')
	await mkdir(join(root, 'applications'), { recursive: true })
	await mkdir(join(root, 'icons/hicolor/48x48/apps'), { recursive: true })
	for (const app of apps) {
		await writeFile(
			join(root, 'applications', app.desktop[0] as string),
			`[Desktop Entry]\nName=${app.id}\nIcon=icon-${app.id}\n`,
		)
		await writeFile(
			join(root, 'icons/hicolor/48x48/apps', `icon-${app.id}.svg`),
			`<svg id="${app.id}"/>`,
		)
	}
	// The dock's own terminal glyph, which the catalogue prefers over the desktop entry's icon.
	await writeFile(
		join(root, 'icons/hicolor/48x48/apps/utilities-terminal.svg'),
		'<svg id="dock-terminal"/>',
	)
	return root
}

describe('the catalogue is built per image stage', () => {
	it('puts every application in exactly one known stage, base ones first', () => {
		const apps = catalogue.APPLICATIONS as App[]
		for (const app of apps) expect(catalogue.STAGES).toContain(app.stage)
		expect(apps.filter((app) => app.stage === 'base').map((app) => app.id)).toEqual(
			expect.arrayContaining(baseIds),
		)
		expect(apps.filter((app) => app.stage === 'base')).toHaveLength(baseIds.length)
	})

	it('lists only the light computer apps for the base stage and everything for creative', () => {
		expect((catalogue.applicationsForStage('base') as App[]).map((app) => app.id).sort()).toEqual(
			[...baseIds].sort(),
		)
		expect(catalogue.applicationsForStage('creative')).toHaveLength(catalogue.APPLICATIONS.length)
		expect(() => catalogue.applicationsForStage('huge')).toThrow('Unknown image stage')
	})

	it('reads the stage an image was built as, and falls back to the whole catalogue', () => {
		expect(catalogue.activeStage(() => 'base\n')).toBe('base')
		expect(catalogue.activeStage(() => 'creative\n')).toBe('creative')
		expect(catalogue.activeStage(() => 'nonsense')).toBe('creative')
		expect(
			catalogue.activeStage(() => {
				throw new Error('no marker')
			}),
		).toBe('creative')
		expect(
			(catalogue.activeApplications(() => 'base') as App[]).map((app) => app.id).sort(),
		).toEqual([...baseIds].sort())
	})

	it('does not launch an application the stage did not install, even if its binary exists', () => {
		const base = catalogue.applicationsForStage('base')
		expect(catalogue.installedApplication('blender', () => undefined, base)).toBeUndefined()
		expect(catalogue.installedApplication('editor', () => undefined, base)?.id).toBe('editor')
	})

	it('prepares the base home from its three apps and records the stage', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'namzu-stage-base-'))
		try {
			const apps = catalogue.APPLICATIONS as { id: string; desktop: readonly string[] }[]
			const root = await shareRoot(directory, apps)
			const destination = join(directory, 'opt/new-tab')
			const checked: string[] = []
			const prepared = prepareHome({
				stage: 'base',
				shareRoot: root,
				destination,
				applicationExists: (app: { id: string }) => {
					checked.push(app.id)
					return true
				},
			}) as { id: string; icon: string }[]
			expect(prepared.map((app) => app.id).sort()).toEqual([...baseIds].sort())
			// Nothing outside the stage is checked, so a creative-only app cannot fail the base build.
			expect(checked.sort()).toEqual([...baseIds].sort())
			expect(JSON.parse(await readFile(join(destination, 'apps.json'), 'utf8'))).toEqual(prepared)
			expect((await readFile(join(directory, 'opt/stage'), 'utf8')).trim()).toBe('base')
			// Terminal keeps its own icon, not the plain xterm pixmap its desktop entry names.
			const terminal = prepared.find((app) => app.id === 'terminal')
			expect(await readFile(join(destination, terminal?.icon as string), 'utf8')).toBe(
				'<svg id="dock-terminal"/>',
			)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	it('fails a creative build whose apps are missing, but never a base build for them', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'namzu-stage-creative-'))
		try {
			const apps = catalogue.APPLICATIONS as { id: string; desktop: readonly string[] }[]
			const root = await shareRoot(
				directory,
				apps.filter((app) => baseIds.includes(app.id)),
			)
			const destination = join(directory, 'opt/new-tab')
			expect(() =>
				prepareHome({ stage: 'base', shareRoot: root, destination, applicationExists: () => true }),
			).not.toThrow()
			expect(() =>
				prepareHome({
					stage: 'creative',
					shareRoot: root,
					destination,
					applicationExists: () => true,
				}),
			).toThrow('Installed guest application entry is missing: blender')
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	it('takes the stage from --stage and refuses an unknown one', () => {
		expect(stageArgument(['--stage', 'base'])).toBe('base')
		expect(stageArgument([])).toBe('creative')
		expect(() => stageArgument(['--stage', 'tiny'])).toThrow('Unknown image stage: tiny')
		expect(() => stageArgument(['--stage'])).toThrow('Unknown image stage')
	})

	it('writes a managed browser policy with no browser sign-in', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'namzu-policy-'))
		try {
			installBrowserPolicy(join(directory, 'managed'))
			const written = JSON.parse(await readFile(join(directory, 'managed/namzu.json'), 'utf8'))
			expect(written).toEqual(BROWSER_POLICY)
			expect(written.BrowserSignin).toBe(0)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})
})
