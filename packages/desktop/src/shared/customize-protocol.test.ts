import { describe, expect, it } from 'vitest'
import {
	readMarketplaceAdd,
	readMarketplaceAvailable,
	readMarketplaceList,
	readMarketplacePreview,
	readMarketplaceRemove,
	readMarketplaceUpdate,
	readOpCancel,
	readOpProgress,
	readPluginEnable,
	readPluginInstall,
	readPluginManifestView,
	readPluginPlan,
	readPluginStage,
	readPluginUninstall,
	readPluginUpdate,
	readPluginUpdateCheck,
	readSkillCatalog,
	readSkillCreate,
	readSkillFileText,
	readSkillFiles,
	readSkillInstall,
	readSkillRemove,
	readSkillStage,
	withManifestDetails,
} from './customize-protocol.js'

const entry = {
	name: 'a',
	description: 'd',
	tier: 'user',
	place: 'user',
	state: 'on',
	fileCount: 2,
	removable: true,
}

describe('reading the skill catalog', () => {
	it('keeps the known fields, once per name, and drops the rest', () => {
		const view = readSkillCatalog({
			skills: [
				{
					...entry,
					secret: '/home/x',
					plugin: 'p',
					updatedAt: '2026-11-01T00:00:00.000Z',
					lastUsedAt: 'not a time',
					uses7d: 3,
					uses: -1,
				},
				entry,
				{ ...entry, name: '' },
				{ ...entry, name: 'b', state: 'sideways' },
				{ ...entry, name: 'c', place: undefined },
				'x',
			],
		})
		expect(view.skills).toEqual([
			{
				name: 'a',
				description: 'd',
				tier: 'user',
				place: 'user',
				plugin: 'p',
				state: 'on',
				updatedAt: '2026-11-01T00:00:00.000Z',
				fileCount: 2,
				uses7d: 3,
				removable: true,
			},
		])
	})
	it('caps the list, the description and the file count', () => {
		const many = Array.from({ length: 700 }, (_, i) => ({ ...entry, name: `s${i}` }))
		expect(readSkillCatalog({ skills: many }).skills).toHaveLength(500)
		const long = readSkillCatalog({
			skills: [{ ...entry, description: 'x'.repeat(5000), fileCount: 99999 }],
		}).skills[0]
		expect(long?.description).toHaveLength(1024)
		expect(long?.fileCount).toBe(200)
	})
	it('answers an empty list for anything that is not a list', () => {
		expect(readSkillCatalog(undefined)).toEqual({ skills: [] })
		expect(readSkillCatalog({ skills: 'a' })).toEqual({ skills: [] })
	})
})

describe('reading a skill’s files', () => {
	it('keeps relative paths with sizes, at most 200, and drops paths that leave the folder', () => {
		const files = readSkillFiles({
			files: [
				{ path: 'a.md', size: 1, extra: 1 },
				{ path: '../x', size: 1 },
				{ path: '/etc/passwd', size: 1 },
				{ path: 'a/../../b', size: 1 },
				{ path: 'n\0', size: 1 },
				{ path: 'ok/b.txt', size: -1 },
				{ path: 'ok/c.txt', size: 4 },
			],
		})
		expect(files).toEqual({
			files: [
				{ path: 'a.md', size: 1 },
				{ path: 'ok/c.txt', size: 4 },
			],
		})
		const many = Array.from({ length: 300 }, (_, i) => ({ path: `f${i}`, size: 1 }))
		expect(readSkillFiles({ files: many }).files).toHaveLength(200)
	})
})

describe('reading a skill’s file text', () => {
	it('takes a text and a truncated flag, cut at 256 KiB, or nothing', () => {
		expect(readSkillFileText({ text: 'hi', truncated: false })).toEqual({
			text: 'hi',
			truncated: false,
		})
		expect(readSkillFileText({ text: 'x'.repeat(300_000), truncated: true })?.text).toHaveLength(
			256 * 1024,
		)
		expect(readSkillFileText({ text: 'hi' })).toBeNull()
		expect(readSkillFileText(null)).toBeNull()
	})
})

describe('reading a plugin’s manifest fields', () => {
	it('keeps skills, servers, author and time, and nothing else', () => {
		expect(
			readPluginManifestView({
				name: 'p',
				skills: [{ name: 'p__a', description: 'd', path: '/x' }, { name: '' }, 4],
				servers: [{ name: 'notes', env: { K: 'v' } }, {}],
				author: 'Someone',
				updatedAt: '2026-11-01T00:00:00.000Z',
			}),
		).toEqual({
			skills: [{ name: 'p__a', description: 'd' }],
			servers: [{ name: 'notes' }],
			author: 'Someone',
			updatedAt: '2026-11-01T00:00:00.000Z',
		})
		expect(readPluginManifestView({ updatedAt: 'x', author: '' })).toEqual({})
		expect(readPluginManifestView('x')).toEqual({})
	})
	it('reads the identity of a plugin Namzu installed and nothing it cannot trust', () => {
		expect(
			readPluginManifestView({
				id: 'ledger@team-tools',
				marketplace: 'team-tools',
				layout: 'common',
				installed: ['user', 'user', 'nowhere', 'local'],
				findings: { warning: 2, 'bad level!': 3, ignored: 'many' },
				updateKnown: true,
			}),
		).toEqual({
			id: 'ledger@team-tools',
			marketplace: 'team-tools',
			layout: 'common',
			installed: ['user', 'local'],
			findings: { warning: 2 },
			updateKnown: true,
		})
		expect(
			readPluginManifestView({ layout: 'other', updateKnown: 'yes', installed: 'user' }),
		).toEqual({})
	})
	it('keeps those fields on an inventory row only after reading them', () => {
		const view = withManifestDetails({
			live: false,
			plugins: [{ name: 'p', id: 'p@m', marketplace: 7, installed: ['project', 'x'] }],
		})
		expect(view.plugins).toEqual([{ name: 'p', id: 'p@m', installed: ['project'] }])
	})
	it('cleans each plugin of an inventory and leaves its other fields alone', () => {
		const view = withManifestDetails({
			live: false,
			plugins: [{ name: 'p', version: '1', skills: 'bad', author: 'A', servers: [{ name: 's' }] }],
		})
		expect(view).toEqual({
			live: false,
			plugins: [{ name: 'p', version: '1', author: 'A', servers: [{ name: 's' }] }],
		})
	})
})

describe('reading a skill stage', () => {
	const item = {
		fileName: 'weekly.md',
		kind: 'file',
		name: 'weekly-report',
		description: 'Does a thing.',
		files: 1,
		bytes: 120,
		findings: ['kept a key'],
		grants: ['Runs commands: date'],
		scripts: [],
	}
	const stage = { stageId: 's1', expiresAt: '2026-11-27T10:10:00.000Z', items: [item] }

	it('keeps the known fields and drops the rest', () => {
		const view = readSkillStage({
			...stage,
			secret: 1,
			items: [{ ...item, path: '/home/x', collides: ['user', 'team', 'user', 'project'] }],
		})
		expect(view).toEqual({
			...stage,
			items: [{ ...item, collides: ['user', 'project'] }],
		})
	})

	it('is null unless it has an id, a time and a list', () => {
		expect(readSkillStage(null)).toBeNull()
		expect(readSkillStage({ ...stage, stageId: '' })).toBeNull()
		expect(readSkillStage({ ...stage, expiresAt: 'later' })).toBeNull()
		expect(readSkillStage({ ...stage, items: 'x' })).toBeNull()
	})

	it('drops items without a name or kind, caps lines and items, and keeps an error', () => {
		const view = readSkillStage({
			...stage,
			items: [
				{ ...item, fileName: '' },
				{ ...item, kind: 'link' },
				{ fileName: 'bad.txt', kind: 'file', error: 'Not a skill.', findings: 'x' },
				{ ...item, findings: Array.from({ length: 50 }, () => 'y'.repeat(500)) },
				...Array.from({ length: 40 }, () => item),
			],
		})
		expect(view?.items.length).toBe(18)
		expect(view?.items[0]).toEqual({
			fileName: 'bad.txt',
			kind: 'file',
			findings: [],
			grants: [],
			scripts: [],
			error: 'Not a skill.',
		})
		expect(view?.items[1]?.findings.length).toBe(20)
		expect(view?.items[1]?.findings[0]?.length).toBe(300)
	})
})

describe('reading the answers to install, create and remove', () => {
	it('keeps results with a known outcome', () => {
		expect(
			readSkillInstall({
				note: 'It loads in new conversations.',
				extra: 1,
				results: [
					{ name: 'a', outcome: 'added', path: '/p/SKILL.md', secret: 1 },
					{ name: 'b', outcome: 'failed', error: 'Nope.' },
					{ name: 'c', outcome: 'maybe' },
					{ outcome: 'added' },
				],
			}),
		).toEqual({
			note: 'It loads in new conversations.',
			results: [
				{ name: 'a', outcome: 'added', path: '/p/SKILL.md' },
				{ name: 'b', outcome: 'failed', error: 'Nope.' },
			],
		})
		expect(readSkillInstall({})).toBeNull()
	})

	it('reads a create answer by its outcome', () => {
		expect(readSkillCreate({ outcome: 'created', path: '/p', x: 1 })).toEqual({
			outcome: 'created',
			path: '/p',
		})
		expect(readSkillCreate({ outcome: 'exists', error: 'There.' })).toEqual({
			outcome: 'exists',
			error: 'There.',
		})
		expect(readSkillCreate({ outcome: 'done' })).toBeNull()
		expect(readSkillCreate('x')).toBeNull()
	})

	it('reads a remove answer', () => {
		expect(readSkillRemove({ outcome: 'removed', backup: '/b', x: 1 })).toEqual({
			outcome: 'removed',
			backup: '/b',
		})
		expect(readSkillRemove({ outcome: 'not-found', error: 'No skill.' })).toEqual({
			outcome: 'not-found',
			error: 'No skill.',
		})
		expect(readSkillRemove({})).toBeNull()
	})
})

const digest = 'a'.repeat(64)
const plan = {
	planId: 'p1',
	digest,
	id: 'ledger@team',
	name: 'ledger',
	version: '1.0.0',
	layout: 'common',
	scope: 'user',
	components: { skills: ['ledger__a'], commands: ['close'], agents: [] },
	surface: {
		hooks: [
			{
				event: 'pre_tool_use',
				matcher: 'Bash',
				type: 'command',
				run: 'guard.sh',
				from: 'hooks/hooks.json',
			},
		],
		fileHooks: [],
		mcpLocal: [
			{ name: 'db', command: 'node', args: ['server.js'], envNames: ['MODE'], secret: 'x' },
		],
		mcpRemote: [
			{
				name: 'api',
				origin: 'https://mcp.example.com',
				transport: 'http',
				sendsEnv: ['TOKEN'],
				headers: ['Authorization'],
			},
		],
		modules: [{ path: 'hooks/mod.js', isolated: true, declares: ['Bash'] }],
		allowedTools: [{ kind: 'skill', name: 'a', tools: ['Read'] }],
		scripts: [{ path: 'scripts/guard.sh', bytes: 20, exec: true }],
		scriptsTotal: 1,
		unpinnedDownload: false,
	},
	findings: [{ level: 'notUsed', code: 'x', field: 'f', message: 'm' }],
	warnings: ['w'],
	preview: `Install?\nSurface: sha256:${digest}`,
	loadingOn: false,
	expiresAt: '2026-11-27T10:10:00.000Z',
}

describe('reading marketplace answers', () => {
	it('reads a preview, an error, and refuses a shape it does not know', () => {
		expect(
			readMarketplacePreview({ source: '/m', kind: 'path', remote: false, notice: 'n', extra: 1 }),
		).toEqual({ source: '/m', kind: 'path', remote: false, notice: 'n' })
		expect(
			readMarketplacePreview({ source: 'a/b', kind: 'github', remote: true, blocked: 'later' }),
		).toMatchObject({ blocked: 'later', remote: true })
		expect(readMarketplacePreview({ error: 'No.' })).toEqual({ error: 'No.' })
		expect(readMarketplacePreview({ source: '/m' })).toBeNull()
		expect(readMarketplacePreview('x')).toBeNull()
	})
	it('reads add, list, remove, update and available, capped and without extra keys', () => {
		expect(
			readMarketplaceAdd({ name: 't', plugins: 2, outcome: 'added', warnings: ['w', 3], x: 1 }),
		).toEqual({ name: 't', plugins: 2, outcome: 'added', warnings: ['w'] })
		expect(readMarketplaceAdd({ name: 't', plugins: 2, outcome: 'maybe' })).toBeNull()
		const list = readMarketplaceList({
			marketplaces: [
				{
					name: 't',
					source: '/m',
					kind: 'directory',
					plugins: null,
					installed: 1,
					autoUpdate: false,
					lastUpdated: 'bad',
					path: '/secret',
				},
				{ name: '' },
			],
			declaredByProject: [
				{ name: 'p', declaredBy: 'project' },
				{ name: 'q', declaredBy: 'user' },
			],
			problems: ['a'],
		})
		expect(list?.marketplaces).toEqual([
			{
				name: 't',
				source: '/m',
				kind: 'directory',
				autoUpdate: false,
				plugins: null,
				installed: 1,
			},
		])
		expect(list?.declaredByProject).toEqual([{ name: 'p', declaredBy: 'project' }])
		expect(
			readMarketplaceList({
				marketplaces: Array.from({ length: 300 }, (_, i) => ({
					name: `m${i}`,
					source: 's',
					kind: 'file',
				})),
			})?.marketplaces,
		).toHaveLength(100)
		expect(
			readMarketplaceRemove({ outcome: 'removed', name: 't', removedPlugins: ['a@t (user)'] }),
		).toEqual({ name: 't', removedPlugins: ['a@t (user)'] })
		expect(readMarketplaceRemove({ outcome: 'nope', name: 't' })).toBeNull()
		expect(
			readMarketplaceUpdate({
				results: [
					{ name: 't', outcome: 'updated', plugins: 3 },
					{ name: 'u', outcome: 'failed', error: 'e' },
					{ name: 'v', outcome: 'x' },
				],
			})?.results,
		).toHaveLength(2)
		const available = readMarketplaceAvailable({
			marketplace: 't',
			plugins: [
				{
					name: 'a',
					id: 'a@t',
					installable: true,
					installedAt: ['user', 'team'],
					description: 'd',
				},
				{ name: 'b', id: 'b@t', installable: 'yes' },
			],
			warnings: [],
		})
		expect(available?.plugins).toEqual([
			{ name: 'a', id: 'a@t', description: 'd', installable: true, installedAt: ['user'] },
		])
	})
})

describe('reading plugin answers', () => {
	it('reads what runs whole, so a long command is not cut where the person says yes', () => {
		const run = `echo ${'a'.repeat(1500)} tail-end`
		const view = readPluginPlan({
			...plan,
			surface: { ...plan.surface, hooks: [{ event: 'pre_tool_use', type: 'command', run }] },
		})
		expect(view?.surface.hooks[0]?.run).toBe(run)
	})
	it('reads a plan with its surface and digest, and keeps names but never environment values', () => {
		const view = readPluginPlan(plan)
		expect(view?.digest).toBe(digest)
		expect(view?.surface.mcpRemote[0]).toEqual({
			name: 'api',
			origin: 'https://mcp.example.com',
			transport: 'http',
			sendsEnv: ['TOKEN'],
			headers: ['Authorization'],
		})
		expect(view?.surface.mcpLocal[0]).toEqual({
			name: 'db',
			command: 'node',
			args: ['server.js'],
			envNames: ['MODE'],
		})
		expect(view?.surface.modules[0]).toEqual({
			path: 'hooks/mod.js',
			isolated: true,
			declares: ['Bash'],
		})
		expect(view?.layout).toBe('common')
		expect(view?.preview).toContain(digest)
	})
	it('refuses a plan without a digest, a scope, a surface or an expiry', () => {
		for (const bad of [
			{ ...plan, digest: 'abc' },
			{ ...plan, scope: 'team' },
			{ ...plan, surface: undefined },
			{ ...plan, expiresAt: 'soon' },
			{ ...plan, planId: '' },
			{ ...plan, loadingOn: 'no' },
			null,
		])
			expect(readPluginPlan(bad)).toBeNull()
	})
	it('caps what a plan lists', () => {
		const many = Array.from({ length: 300 }, (_, i) => ({ path: `s${i}`, bytes: 1, exec: false }))
		const view = readPluginPlan({
			...plan,
			surface: { ...plan.surface, scripts: many, scriptsTotal: 300 },
			findings: Array.from({ length: 80 }, () => plan.findings[0]),
		})
		expect(view?.surface.scripts).toHaveLength(100)
		expect(view?.surface.scriptsTotal).toBe(300)
		expect(view?.findings).toHaveLength(50)
	})
	it('reads stage, install, enable, update check, update and uninstall', () => {
		expect(
			readPluginStage({
				stageId: 's',
				name: 'n',
				version: '1',
				expiresAt: '2026-11-27T10:10:00.000Z',
			}),
		).toMatchObject({ stageId: 's' })
		expect(readPluginStage({ stageId: 's' })).toBeNull()
		expect(
			readPluginInstall({
				id: 'a@b',
				outcome: 'installed',
				loading: 'off',
				message: 'm',
				notes: ['n'],
			}),
		).toEqual({ id: 'a@b', outcome: 'installed', loading: 'off', message: 'm', notes: ['n'] })
		expect(
			readPluginInstall({ id: 'a@b', outcome: 'done', loading: 'off', message: 'm' }),
		).toBeNull()
		expect(
			readPluginEnable({
				outcome: 'disabled',
				id: 'a@b',
				scope: 'local',
				effective: { enabled: false, by: 'user' },
				loading: 'on',
			}),
		).toMatchObject({ effective: { enabled: false, by: 'user' } })
		expect(readPluginEnable({ outcome: 'disabled', id: 'a@b', scope: 'local' })).toBeNull()
		expect(
			readPluginUpdateCheck({
				id: 'a@b',
				current: '1',
				latest: '2',
				upToDate: false,
				changesExecutable: true,
			}),
		).toEqual({ id: 'a@b', current: '1', latest: '2', upToDate: false, changesExecutable: true })
		expect(readPluginUpdateCheck({ id: 'a@b', latest: '2' })).toBeNull()
		expect(
			readPluginUpdate({
				outcome: 'needs-consent',
				id: 'a@b',
				from: '1',
				to: '2',
				digest,
				changes: ['c'],
				surface: plan.surface,
				preview: 'p',
			}),
		).toMatchObject({ outcome: 'needs-consent', digest })
		expect(readPluginUpdate({ outcome: 'needs-consent', id: 'a@b', from: '1', to: '2' })).toBeNull()
		expect(
			readPluginUpdate({ outcome: 'updated', id: 'a@b', from: '1', to: '2', message: 'm' }),
		).toMatchObject({ outcome: 'updated' })
		expect(
			readPluginUninstall({
				outcome: 'uninstalled',
				id: 'a@b',
				scope: 'user',
				dataKept: true,
				remaining: 1,
			}),
		).toEqual({ id: 'a@b', scope: 'user', dataKept: true, dataDeleted: false, remaining: 1 })
		expect(readPluginUninstall({ outcome: 'x', id: 'a@b', scope: 'user' })).toBeNull()
	})
	it('reads cancel and progress', () => {
		expect(readOpCancel({ cancelled: true })).toEqual({ cancelled: true })
		expect(readOpCancel({})).toBeNull()
		expect(readOpProgress({ opId: 'op-12345678', phase: 'reading', x: 1 })).toEqual({
			opId: 'op-12345678',
			phase: 'reading',
		})
		expect(readOpProgress({ opId: 'short', phase: 'reading' })).toBeNull()
		expect(readOpProgress({ opId: 'op-12345678', phase: 'later' })).toBeNull()
	})
})
