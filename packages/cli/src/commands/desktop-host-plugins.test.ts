import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MANIFEST, makeMarketplace, makePlugin, skill } from '../__fixtures__/plugin-source.js'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	OP_PROGRESS_NOTIFICATION,
	PLUGIN_CANCELLED_MESSAGE,
	PLUGIN_CHANGED_MESSAGE,
	PLUGIN_GONE_MESSAGE,
	PLUGIN_PAL_MESSAGE,
	PLUGIN_PLAN_MAX,
	PLUGIN_STAGE_MAX,
	PLUGIN_STAGE_TTL_MS,
	PLUGIN_TRUST_MESSAGE,
	createDesktopPluginActions,
	surfaceView,
} from './desktop-host-plugins.js'

let root: string
let home: string
let cwd: string
let trusted = true
let pal = false
let loadingOn = false
let notes: { method: string; params: Record<string, unknown> }[] = []
let enabledLoadingCalls = 0

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-11-27T10:00:00.000Z'))
	root = mkdtempSync(join(tmpdir(), 'namzu-host-plugins-'))
	home = join(root, 'home')
	cwd = join(root, 'proj')
	for (const d of [home, cwd]) mkdirSync(d, { recursive: true })
	trusted = true
	pal = false
	loadingOn = false
	notes = []
	enabledLoadingCalls = 0
})
afterEach(() => {
	vi.useRealTimers()
	removeTempDir(root)
})

const actions = () =>
	createDesktopPluginActions({
		cwd,
		home,
		pal: () => pal,
		isTrusted: () => trusted,
		notify: (method, params) => notes.push({ method, params }),
		loadingOn: () => loadingOn,
		enableLoading: () => {
			enabledLoadingCalls++
			loadingOn = true
			return 'Plugin loading is now on.'
		},
	})

function ledger(dir: string, extra: Record<string, unknown> = {}, version = '1.0.0'): string {
	return makePlugin(dir, 'ledger', {
		files: {
			[MANIFEST]: { name: 'ledger', version, description: 'Books.' },
			'skills/reconcile/SKILL.md': skill('reconcile'),
			...extra,
		},
	})
}
function market(name = 'team', version = '1.0.0', extra: Record<string, unknown> = {}): string {
	const dir = join(root, name)
	ledger(join(dir, 'plugins/ledger'), extra, version)
	makeMarketplace(dir, name, [{ name: 'ledger', source: './plugins/ledger' }])
	return dir
}
const addMarket = (m: ReturnType<typeof actions>, dir: string, scope = 'user') =>
	m.methods['namzu/marketplaces/add']({ source: dir, scope, accepted: 'marketplace-v1' })

type Plan = {
	planId: string
	digest: string
	id: string
	version: string
	surface: {
		hooks: { event: string; run: string }[]
		mcpRemote: { origin: string; sendsEnv: string[]; headers: string[] }[]
		mcpLocal: { envNames: string[] }[]
		modules: { path: string }[]
		scripts: unknown[]
	}
	components: { skills: string[] }
	preview: string
	expiresAt: string
	loadingOn: boolean
	installed?: { version: string | null }
}

async function planOf(m: ReturnType<typeof actions>, id = 'ledger@team', scope = 'user') {
	return (await m.methods['namzu/plugins/plan']({ id, scope })) as unknown as Plan
}

describe('namzu/marketplaces', () => {
	it('previews an address without touching the network or the records', () => {
		const m = actions()
		const folder = m.methods['namzu/marketplaces/preview']({ source: market() }) as Record<
			string,
			unknown
		>
		expect(folder).toMatchObject({ kind: 'path', remote: false })
		expect(String(folder.notice)).toContain('Add only marketplaces you trust')
		expect(m.methods['namzu/marketplaces/preview']({ source: 'owner/repo' })).toMatchObject({
			kind: 'github',
			remote: true,
		})
		expect(m.methods['namzu/marketplaces/preview']({ source: 'http://x.test/m' })).toEqual({
			error: expect.stringContaining('https://'),
		})
		expect(existsSync(join(home, '.namzu', 'plugins'))).toBe(false)
	})

	it('adds a folder, lists it, offers its plugins, updates and removes it', async () => {
		const m = actions()
		const dir = market()
		const added = (await addMarket(m, dir)) as Record<string, unknown>
		expect(added).toMatchObject({ name: 'team', plugins: 1, outcome: 'added' })
		expect(notes.map((n) => n.method)).toEqual([])
		const again = (await addMarket(m, dir)) as Record<string, unknown>
		expect(again.outcome).toBe('declared' in again ? 'declared' : 'already-added')
		const list = m.methods['namzu/marketplaces/list']({}) as {
			marketplaces: Record<string, unknown>[]
		}
		expect(list.marketplaces).toEqual([
			expect.objectContaining({ name: 'team', plugins: 1, installed: 0, kind: 'directory' }),
		])
		const available = (await m.methods['namzu/marketplaces/available']({
			marketplace: 'team',
		})) as {
			plugins: { id: string; installable: boolean }[]
		}
		expect(available.plugins).toEqual([
			expect.objectContaining({ id: 'ledger@team', installable: true }),
		])
		const updated = (await m.methods['namzu/marketplaces/update']({})) as { results: unknown[] }
		expect(updated.results).toEqual([{ name: 'team', outcome: 'updated', plugins: 1 }])
		expect(m.methods['namzu/marketplaces/remove']({ name: 'team', confirm: true })).toMatchObject({
			outcome: 'removed',
			removedPlugins: [],
		})
		expect(
			(m.methods['namzu/marketplaces/list']({}) as { marketplaces: unknown[] }).marketplaces,
		).toEqual([])
	})

	it('refuses a download, a missing path, a changed name and an unaccepted notice', async () => {
		const m = actions()
		await expect(addMarket(m, 'owner/repo')).rejects.toThrow('needs a download')
		await expect(addMarket(m, join(root, 'nothing'))).rejects.toThrow('was not found')
		await expect(
			m.methods['namzu/marketplaces/add']({ source: market(), scope: 'user', accepted: 'yes' }),
		).rejects.toThrow('Read the notice first.')
		const first = market('a')
		await addMarket(m, first)
		makeMarketplace(join(root, 'b'), 'a', [])
		await expect(addMarket(m, join(root, 'b'))).rejects.toThrow('already added from another place')
	})

	it('removes the plugins of a marketplace with it, and keeps the folder', async () => {
		const m = actions()
		const dir = market()
		await addMarket(m, dir)
		const plan = await planOf(m)
		await m.methods['namzu/plugins/install']({
			planId: plan.planId,
			digest: plan.digest,
			scope: 'user',
			consent: true,
		})
		expect(() => m.methods['namzu/marketplaces/remove']({ name: 'team' })).toThrow(
			'Invalid marketplace remove request.',
		)
		expect(() => m.methods['namzu/marketplaces/remove']({ name: 'team', confirm: false })).toThrow(
			'Confirm the removal first.',
		)
		const removed = m.methods['namzu/marketplaces/remove']({ name: 'team', confirm: true }) as {
			removedPlugins: string[]
		}
		expect(removed.removedPlugins).toEqual(['ledger@team (user)'])
		expect(existsSync(join(dir, 'plugins/ledger'))).toBe(true)
	})

	it('does not remove a marketplace while a plugin from it is installed in another folder', async () => {
		const m = actions()
		const dir = market()
		await addMarket(m, dir)
		const plan = await planOf(m, 'ledger@team', 'project')
		await m.methods['namzu/plugins/install']({
			planId: plan.planId,
			digest: plan.digest,
			scope: 'project',
			consent: true,
		})
		// Seen from a different folder, that record belongs to the other one.
		cwd = join(root, 'elsewhere')
		mkdirSync(cwd, { recursive: true })
		const other = actions()
		expect(() =>
			other.methods['namzu/marketplaces/remove']({ name: 'team', confirm: true }),
		).toThrow('installed in another folder')
		expect(
			(other.methods['namzu/marketplaces/list']({}) as { marketplaces: unknown[] }).marketplaces,
		).toHaveLength(1)
	})

	it('validates exact keys, names and scopes, and refuses a project place in an untrusted folder', async () => {
		const m = actions()
		const dir = market()
		expect(() => m.methods['namzu/marketplaces/preview']({ source: dir, extra: 1 })).toThrow(
			'Invalid marketplace preview request.',
		)
		expect(() => m.methods['namzu/marketplaces/preview']({})).toThrow(
			'Invalid marketplace preview request.',
		)
		await expect(
			m.methods['namzu/marketplaces/add']({
				source: dir,
				scope: 'team',
				accepted: 'marketplace-v1',
			}),
		).rejects.toThrow('Invalid scope.')
		await expect(
			m.methods['namzu/marketplaces/add']({
				source: 'x'.repeat(4097),
				scope: 'user',
				accepted: 'marketplace-v1',
			}),
		).rejects.toThrow('Invalid source.')
		trusted = false
		await expect(addMarket(m, dir, 'project')).rejects.toThrow(PLUGIN_TRUST_MESSAGE)
		await expect(addMarket(m, dir, 'local')).rejects.toThrow(PLUGIN_TRUST_MESSAGE)
		expect(await addMarket(m, dir, 'user')).toMatchObject({ outcome: 'added' })
	})

	it('records a project declaration in the shared file only for a trusted folder', async () => {
		const m = actions()
		await addMarket(m, market(), 'project')
		expect(existsSync(join(cwd, '.namzu', 'settings.json'))).toBe(true)
	})

	it('refuses a Pal everywhere but cancel', async () => {
		const m = actions()
		pal = true
		for (const [name, params] of [
			['namzu/marketplaces/preview', { source: 'x' }],
			['namzu/marketplaces/list', {}],
			['namzu/plugins/stage', { path: '/x' }],
			['namzu/plugins/plan', { id: 'a@b', scope: 'user' }],
			['namzu/plugins/update_check', { id: 'a@b' }],
		] as const) {
			const call = m.methods[name] as (p: Record<string, unknown>) => unknown
			await expect(Promise.resolve().then(() => call(params))).rejects.toThrow(PLUGIN_PAL_MESSAGE)
		}
		expect(m.methods['namzu/ops/cancel']({ opId: 'op-12345678' })).toEqual({ cancelled: false })
	})
})

describe('namzu/plugins/plan and install', () => {
	it('shows what runs, with the digest, and installs only that', async () => {
		const m = actions()
		await addMarket(
			m,
			market('team', '1.0.0', {
				'hooks/hooks.json': {
					hooks: {
						PreToolUse: [
							{
								matcher: 'Bash',
								hooks: [{ type: 'command', command: '${NAMZU_PLUGIN_ROOT}/scripts/guard.sh' }],
							},
						],
					},
				},
				'scripts/guard.sh': '#!/bin/sh\nexit 0\n',
			}),
		)
		const plan = await planOf(m)
		expect(plan.id).toBe('ledger@team')
		expect(plan.components.skills).toEqual(['ledger__reconcile'])
		expect(plan.surface.hooks[0]).toMatchObject({ event: 'pre_tool_use' })
		expect(plan.surface.scripts).toHaveLength(1)
		expect(plan.preview).toContain(`Surface: sha256:${plan.digest}`)
		expect(plan.digest).toMatch(/^[0-9a-f]{64}$/)
		expect(plan.loadingOn).toBe(false)
		expect(existsSync(join(home, '.namzu', 'plugins', 'cache'))).toBe(false)

		await expect(
			m.methods['namzu/plugins/install']({
				planId: plan.planId,
				digest: '0'.repeat(64),
				scope: 'user',
				consent: true,
			}),
		).rejects.toThrow(PLUGIN_CHANGED_MESSAGE)
		await expect(
			m.methods['namzu/plugins/install']({
				planId: plan.planId,
				digest: plan.digest,
				scope: 'user',
				consent: false,
			}),
		).rejects.toThrow('Say yes')
		const done = (await m.methods['namzu/plugins/install']({
			planId: plan.planId,
			digest: plan.digest,
			scope: 'user',
			consent: true,
			enableLoading: true,
		})) as { id: string; loading: string; message: string; outcome: string }
		expect(done).toMatchObject({ id: 'ledger@team', loading: 'on', outcome: 'installed' })
		expect(done.message).toContain('It loads in new conversations.')
		expect(enabledLoadingCalls).toBe(1)
		expect(existsSync(join(home, '.namzu', 'plugins', 'cache', 'team', 'ledger', '1.0.0'))).toBe(
			true,
		)
		// A plan is used once.
		await expect(
			m.methods['namzu/plugins/install']({
				planId: plan.planId,
				digest: plan.digest,
				scope: 'user',
				consent: true,
			}),
		).rejects.toThrow(PLUGIN_GONE_MESSAGE)
		expect(readdirSync(join(home, '.namzu', 'plugins', '.staging'))).toEqual([])
	})

	it('shows a long command whole, and refuses a plugin it could only show cut', async () => {
		const hookFor = (command: string) => ({
			'hooks/hooks.json': {
				hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] },
			},
		})
		const long = `echo ${'a'.repeat(1200)} tail-end`
		const m = actions()
		await addMarket(m, market('team', '1.0.0', hookFor(long)))
		const plan = await planOf(m)
		expect(plan.surface.hooks[0]?.run).toBe(long)

		const m2 = actions()
		await addMarket(m2, market('big', '1.0.0', hookFor(`echo ${'b'.repeat(2100)}`)))
		await expect(planOf(m2, 'ledger@big')).rejects.toThrow('more than can be shown in full')

		// A list past its cap is refused too, not cut: the engine's own limits keep real plugins below it.
		const hooks = Array.from({ length: 101 }, (_, i) => ({
			event: 'pre_tool_use',
			type: 'command',
			run: `h${i}`,
		}))
		expect(() =>
			surfaceView({ ...plan.surface, hooks } as unknown as Parameters<typeof surfaceView>[0]),
		).toThrow('more than can be shown in full')
	})

	it('says loading is off when it is not turned on, and shows what a remote server would send', async () => {
		const m = actions()
		await addMarket(
			m,
			market('team', '1.0.0', {
				'.mcp.json': {
					mcpServers: {
						cloud: {
							type: 'http',
							url: 'https://example.test/mcp?k=${TOKEN}',
							headers: { Authorization: 'Bearer ${TOKEN}' },
						},
					},
				},
			}),
		)
		const plan = await planOf(m)
		expect(plan.surface.mcpRemote[0]).toMatchObject({
			origin: 'https://example.test',
			sendsEnv: ['TOKEN'],
			headers: ['Authorization'],
		})
		const done = (await m.methods['namzu/plugins/install']({
			planId: plan.planId,
			digest: plan.digest,
			scope: 'user',
			consent: true,
		})) as { loading: string; notes?: string[] }
		expect(done.loading).toBe('off')
		expect(done.notes?.join(' ')).toContain('Plugin loading is off')
		expect(enabledLoadingCalls).toBe(0)
	})

	it('refuses an install whose staged files changed after the plan was shown', async () => {
		const m = actions()
		await addMarket(m, market('team', '1.0.0', { 'scripts/guard.sh': '#!/bin/sh\nexit 0\n' }))
		const plan = await planOf(m)
		const staged = [...m.plans.values()][0]?.plan
		writeFileSync(join(staged?.root as string, 'scripts', 'guard.sh'), '#!/bin/sh\nrm -rf x\n')
		await expect(
			m.methods['namzu/plugins/install']({
				planId: plan.planId,
				digest: plan.digest,
				scope: 'user',
				consent: true,
			}),
		).rejects.toThrow(PLUGIN_CHANGED_MESSAGE)
		expect(m.plans.size).toBe(0)
		expect(existsSync(staged?.stagingDir as string)).toBe(false)
		expect(existsSync(join(home, '.namzu', 'plugins', 'cache'))).toBe(false)
	})

	it('expires a plan after ten minutes and removes its copy', async () => {
		const m = actions()
		await addMarket(m, market())
		const plan = await planOf(m)
		const staging = [...m.plans.values()][0]?.plan.stagingDir as string
		expect(plan.expiresAt).toBe(new Date(Date.now() + PLUGIN_STAGE_TTL_MS).toISOString())
		vi.advanceTimersByTime(PLUGIN_STAGE_TTL_MS - 1)
		expect(existsSync(staging)).toBe(true)
		vi.advanceTimersByTime(2)
		await expect(
			m.methods['namzu/plugins/install']({
				planId: plan.planId,
				digest: plan.digest,
				scope: 'user',
				consent: true,
			}),
		).rejects.toThrow(PLUGIN_GONE_MESSAGE)
		expect(existsSync(staging)).toBe(false)
	})

	it('keeps at most four plans, dropping the oldest with its copy', async () => {
		const m = actions()
		await addMarket(m, market())
		const first = await planOf(m)
		const firstStaging = [...m.plans.values()][0]?.plan.stagingDir as string
		for (let i = 1; i < PLUGIN_PLAN_MAX; i++) await planOf(m)
		expect(m.plans.size).toBe(PLUGIN_PLAN_MAX)
		await planOf(m)
		expect(m.plans.size).toBe(PLUGIN_PLAN_MAX)
		expect(m.plans.has(first.planId)).toBe(false)
		expect(existsSync(firstStaging)).toBe(false)
	})

	it('wants the same place it was shown for', async () => {
		const m = actions()
		await addMarket(m, market())
		const plan = await planOf(m, 'ledger@team', 'local')
		await expect(
			m.methods['namzu/plugins/install']({
				planId: plan.planId,
				digest: plan.digest,
				scope: 'user',
				consent: true,
			}),
		).rejects.toThrow('Read it again for this place')
		const done = await m.methods['namzu/plugins/install']({
			planId: plan.planId,
			digest: plan.digest,
			scope: 'local',
			consent: true,
		})
		expect(done).toMatchObject({ outcome: 'installed' })
	})

	it('refuses a project or local place in an untrusted folder, at plan and at install', async () => {
		const m = actions()
		await addMarket(m, market())
		const plan = await planOf(m)
		trusted = false
		await expect(planOf(m, 'ledger@team', 'project')).rejects.toThrow(PLUGIN_TRUST_MESSAGE)
		await expect(
			m.methods['namzu/plugins/install']({
				planId: plan.planId,
				digest: plan.digest,
				scope: 'local',
				consent: true,
			}),
		).rejects.toThrow(PLUGIN_TRUST_MESSAGE)
		expect((await planOf(m)).id).toBe('ledger@team')
	})

	it('validates exact keys and sizes', async () => {
		const m = actions()
		await expect(m.methods['namzu/plugins/plan']({ scope: 'user' })).rejects.toThrow(
			'Invalid plugin plan request.',
		)
		await expect(
			m.methods['namzu/plugins/plan']({ id: 'a@b', stageId: 'x', scope: 'user' }),
		).rejects.toThrow('Invalid plugin plan request.')
		await expect(
			m.methods['namzu/plugins/plan']({ id: 'not an id', scope: 'user' }),
		).rejects.toThrow('Invalid id.')
		await expect(
			m.methods['namzu/plugins/plan']({ id: 'a@b', scope: 'user', extra: 1 }),
		).rejects.toThrow('Invalid plugin plan request.')
		await expect(
			m.methods['namzu/plugins/install']({ planId: 'p', digest: 'd', scope: 'user' }),
		).rejects.toThrow('Invalid plugin install request.')
		await expect(
			m.methods['namzu/plugins/install']({
				planId: 'p',
				digest: 'd'.repeat(65),
				scope: 'user',
				consent: true,
			}),
		).rejects.toThrow('Invalid digest.')
		await expect(
			m.methods['namzu/plugins/install']({
				planId: 'p',
				digest: 'd',
				scope: 'user',
				consent: true,
				enableLoading: 'yes',
			}),
		).rejects.toThrow('Invalid enableLoading.')
		await expect(
			m.methods['namzu/plugins/plan']({ id: 'ledger@team', scope: 'user', opId: 'x' }),
		).rejects.toThrow('Invalid opId.')
		await expect(m.methods['namzu/plugins/stage']({ path: 'relative.zip' })).rejects.toThrow(
			'That path cannot be used.',
		)
		expect(() => m.methods['namzu/ops/cancel']({ opId: 'a/b' })).toThrow('Invalid opId.')
	})
})

describe('namzu/plugins/stage', () => {
	it('stages a folder, plans it from the stage, installs it as a local upload', async () => {
		const m = actions()
		const plugin = ledger(join(root, 'up/ledger'))
		const staged = (await m.methods['namzu/plugins/stage']({ path: plugin })) as {
			stageId: string
			name: string
			version: string
		}
		expect(staged).toMatchObject({ name: 'ledger', version: '1.0.0' })
		const first = (await m.methods['namzu/plugins/plan']({
			stageId: staged.stageId,
			scope: 'user',
		})) as unknown as Plan
		const second = (await m.methods['namzu/plugins/plan']({
			stageId: staged.stageId,
			scope: 'local',
		})) as unknown as Plan
		expect(first.id).toBe('ledger@local-uploads')
		expect(second.digest).toBe(first.digest)
		const done = await m.methods['namzu/plugins/install']({
			planId: second.planId,
			digest: second.digest,
			scope: 'local',
			consent: true,
		})
		expect(done).toMatchObject({ id: 'ledger@local-uploads', outcome: 'installed' })
		expect(m.stages.size).toBe(0)
		// The other plan read the same copy, which is now installed: it is gone too.
		expect(m.plans.size).toBe(0)
		await expect(
			m.methods['namzu/plugins/install']({
				planId: first.planId,
				digest: first.digest,
				scope: 'user',
				consent: true,
			}),
		).rejects.toThrow(PLUGIN_GONE_MESSAGE)
		expect(m.plans.size).toBe(0)
	})

	it('refuses a link, a missing path and a file that is not a plugin archive', async () => {
		const m = actions()
		const plugin = ledger(join(root, 'up/ledger'))
		const link = join(root, 'link')
		symlinkSync(plugin, link)
		await expect(m.methods['namzu/plugins/stage']({ path: link })).rejects.toThrow('link')
		await expect(m.methods['namzu/plugins/stage']({ path: join(root, 'none') })).rejects.toThrow(
			'could not be read',
		)
		const text = join(root, 'a.zip')
		writeFileSync(text, 'not a zip')
		await expect(m.methods['namzu/plugins/stage']({ path: text })).rejects.toThrow()
		expect(m.stages.size).toBe(0)
		expect(readdirSync(join(home, '.namzu', 'plugins', '.staging'))).toEqual([])
	})

	it('keeps at most four stages and expires them', async () => {
		const m = actions()
		const plugin = ledger(join(root, 'up/ledger'))
		const ids: string[] = []
		for (let i = 0; i < PLUGIN_STAGE_MAX + 1; i++)
			ids.push(
				((await m.methods['namzu/plugins/stage']({ path: plugin })) as { stageId: string }).stageId,
			)
		expect(m.stages.size).toBe(PLUGIN_STAGE_MAX)
		expect(m.stages.has(ids[0] as string)).toBe(false)
		vi.advanceTimersByTime(PLUGIN_STAGE_TTL_MS + 1)
		await expect(
			m.methods['namzu/plugins/plan']({ stageId: ids[4], scope: 'user' }),
		).rejects.toThrow(PLUGIN_GONE_MESSAGE)
		expect(m.stages.size).toBe(0)
		expect(readdirSync(join(home, '.namzu', 'plugins', '.staging'))).toEqual([])
	})
})

describe('namzu/plugins/enable, update and uninstall', () => {
	async function installed(m: ReturnType<typeof actions>, dir: string, scope = 'user') {
		await addMarket(m, dir)
		const plan = await planOf(m, 'ledger@team', scope)
		await m.methods['namzu/plugins/install']({
			planId: plan.planId,
			digest: plan.digest,
			scope,
			consent: true,
		})
	}

	it('writes the saved yes or no, and says when nothing changed', async () => {
		const m = actions()
		await installed(m, market())
		expect(
			m.methods['namzu/plugins/enable']({ id: 'ledger@team', scope: 'user', enabled: false }),
		).toMatchObject({ outcome: 'disabled', effective: { enabled: false } })
		expect(
			m.methods['namzu/plugins/enable']({ id: 'ledger@team', scope: 'user', enabled: false }),
		).toMatchObject({ outcome: 'unchanged' })
		expect(
			m.methods['namzu/plugins/enable']({ id: 'ledger@team', scope: 'user', enabled: true }),
		).toMatchObject({ outcome: 'enabled', note: 'It loads in new conversations.' })
		expect(() =>
			m.methods['namzu/plugins/enable']({ id: 'nope@team', scope: 'user', enabled: true }),
		).toThrow('is not installed')
		expect(() =>
			m.methods['namzu/plugins/enable']({ id: 'ledger@team', scope: 'user', enabled: 'yes' }),
		).toThrow('Invalid enabled.')
		trusted = false
		expect(() =>
			m.methods['namzu/plugins/enable']({ id: 'ledger@team', scope: 'project', enabled: true }),
		).toThrow(PLUGIN_TRUST_MESSAGE)
	})

	it('adds a row for an installed plugin the listing did not name, and none for one it did', async () => {
		const m = actions()
		await installed(m, market())
		const view = await m.withInstalled({ plugins: [], live: false })
		expect(view.plugins).toHaveLength(1)
		expect(view.plugins[0]).toMatchObject({
			name: 'ledger',
			version: '1.0.0',
			scope: 'user',
			status: 'installed',
			startupEnabled: true,
		})
		const listed = { plugins: [{ name: 'ledger' }], live: true }
		expect(await m.withInstalled(listed)).toBe(listed)
		// The "off" line is dropped once loading is on, because the listing was read before.
		const stale = { plugins: [], live: false, notice: 'Plugins are off for this project.' }
		expect((await m.withInstalled(stale)).notice).toBe(stale.notice)
		loadingOn = true
		expect((await m.withInstalled(stale)).notice).toBeUndefined()
		loadingOn = false
		// A plugin that was turned off shows as off, and a live listing says it is not loaded.
		m.methods['namzu/plugins/enable']({ id: 'ledger@team', scope: 'user', enabled: false })
		const off = await m.withInstalled({ plugins: [], live: true })
		expect(off.plugins[0]).toMatchObject({ status: 'disabled', startupEnabled: false })
		// The id and the marketplace come from the same pass of the listing.
		expect(m.enrichList(off).plugins[0]).toMatchObject({ id: 'ledger@team', marketplace: 'team' })
	})

	it('checks for an update, and updates without a new yes when nothing that runs changed', async () => {
		const m = actions()
		const dir = market()
		await installed(m, dir)
		expect(await m.methods['namzu/plugins/update_check']({ id: 'ledger@team' })).toMatchObject({
			current: '1.0.0',
			latest: '1.0.0',
			upToDate: true,
		})
		makePlugin(join(dir, 'plugins/ledger'), 'ledger', {
			files: {
				[MANIFEST]: { name: 'ledger', version: '1.1.0', description: 'Books.' },
				'skills/reconcile/SKILL.md': skill('reconcile'),
			},
		})
		expect(await m.methods['namzu/plugins/update_check']({ id: 'ledger@team' })).toMatchObject({
			latest: '1.1.0',
			upToDate: false,
			changesExecutable: false,
		})
		const listed = m.enrichList({ plugins: [{ name: 'ledger' }] }) as {
			plugins: Record<string, unknown>[]
		}
		expect(listed.plugins[0]).toMatchObject({
			id: 'ledger@team',
			marketplace: 'team',
			installed: ['user'],
			updateKnown: true,
		})
		const done = await m.methods['namzu/plugins/update']({ id: 'ledger@team' })
		expect(done).toMatchObject({ outcome: 'updated', from: '1.0.0', to: '1.1.0' })
		expect(
			(m.enrichList({ plugins: [{ name: 'ledger' }] }).plugins[0] as Record<string, unknown>)
				.updateKnown,
		).toBeUndefined()
		expect(readdirSync(join(home, '.namzu', 'plugins', '.staging'))).toEqual([])
	})

	it('writes nothing for an update that changes what runs until the digest it showed comes back', async () => {
		const m = actions()
		const dir = market()
		await installed(m, dir)
		makePlugin(join(dir, 'plugins/ledger'), 'ledger', {
			files: {
				[MANIFEST]: { name: 'ledger', version: '1.1.0', description: 'Books.' },
				'skills/reconcile/SKILL.md': skill('reconcile'),
				'scripts/guard.sh': '#!/bin/sh\nexit 0\n',
				'hooks/hooks.json': {
					hooks: {
						PreToolUse: [
							{
								matcher: 'Bash',
								hooks: [{ type: 'command', command: '${NAMZU_PLUGIN_ROOT}/scripts/guard.sh' }],
							},
						],
					},
				},
			},
		})
		expect(await m.methods['namzu/plugins/update_check']({ id: 'ledger@team' })).toMatchObject({
			changesExecutable: true,
		})
		const asked = (await m.methods['namzu/plugins/update']({ id: 'ledger@team' })) as {
			outcome: string
			digest: string
			changes: string[]
			preview: string
		}
		expect(asked.outcome).toBe('needs-consent')
		expect(asked.changes.length).toBeGreaterThan(0)
		expect(existsSync(join(home, '.namzu', 'plugins', 'cache', 'team', 'ledger', '1.1.0'))).toBe(
			false,
		)
		const wrong = await m.methods['namzu/plugins/update']({
			id: 'ledger@team',
			acceptDigest: '0'.repeat(64),
		})
		expect(wrong).toMatchObject({ outcome: 'needs-consent' })
		const done = await m.methods['namzu/plugins/update']({
			id: 'ledger@team',
			acceptDigest: asked.digest,
		})
		expect(done).toMatchObject({ outcome: 'updated', to: '1.1.0' })
	})

	it('uninstalls with a confirm, keeps data unless asked, and wants a trusted folder for a project place', async () => {
		const m = actions()
		await installed(m, market(), 'local')
		expect(() =>
			m.methods['namzu/plugins/uninstall']({ id: 'ledger@team', scope: 'local' }),
		).toThrow('Invalid plugin uninstall request.')
		expect(() =>
			m.methods['namzu/plugins/uninstall']({ id: 'ledger@team', scope: 'local', confirm: false }),
		).toThrow('Confirm the removal first.')
		expect(() =>
			m.methods['namzu/plugins/uninstall']({ id: 'ledger@team', scope: 'user', confirm: true }),
		).toThrow('is not installed at scope user')
		trusted = false
		expect(() =>
			m.methods['namzu/plugins/uninstall']({ id: 'ledger@team', scope: 'local', confirm: true }),
		).toThrow(PLUGIN_TRUST_MESSAGE)
		trusted = true
		expect(
			m.methods['namzu/plugins/uninstall']({
				id: 'ledger@team',
				scope: 'local',
				deleteData: false,
				confirm: true,
			}),
		).toMatchObject({ outcome: 'uninstalled', remaining: 0 })
		expect(existsSync(join(home, '.namzu', 'plugins', 'cache', 'team', 'ledger'))).toBe(false)
	})
})

describe('progress and cancel', () => {
	it('announces the phases of a step the page named, and ends it', async () => {
		const m = actions()
		await m.methods['namzu/marketplaces/add']({
			source: market(),
			scope: 'user',
			accepted: 'marketplace-v1',
			opId: 'op-add-00001',
		})
		expect(notes).toEqual([
			{ method: OP_PROGRESS_NOTIFICATION, params: { opId: 'op-add-00001', phase: 'checking' } },
			{ method: OP_PROGRESS_NOTIFICATION, params: { opId: 'op-add-00001', phase: 'reading' } },
		])
		expect(m.ops.size).toBe(0)
	})

	it('stops a step at its next check and writes nothing', async () => {
		const m = actions()
		await addMarket(m, market())
		const running = m.methods['namzu/plugins/plan']({
			id: 'ledger@team',
			scope: 'user',
			opId: 'op-plan-0001',
		})
		expect(m.methods['namzu/ops/cancel']({ opId: 'op-plan-0001' })).toEqual({ cancelled: true })
		await expect(running).rejects.toThrow(PLUGIN_CANCELLED_MESSAGE)
		expect(m.plans.size).toBe(0)
		expect(m.ops.size).toBe(0)
		expect(existsSync(join(home, '.namzu', 'plugins', '.staging'))).toBe(false)
		expect(m.methods['namzu/ops/cancel']({ opId: 'op-plan-0001' })).toEqual({ cancelled: false })
	})

	it('refuses a second step under a name already running', async () => {
		const m = actions()
		await addMarket(m, market())
		const first = m.methods['namzu/plugins/plan']({
			id: 'ledger@team',
			scope: 'user',
			opId: 'op-twice-001',
		})
		await expect(
			m.methods['namzu/plugins/plan']({ id: 'ledger@team', scope: 'user', opId: 'op-twice-001' }),
		).rejects.toThrow('already running')
		await first
	})
})

describe('namzu/plugins/list additions', () => {
	it('leaves a row alone that no install record names', () => {
		const m = actions()
		const view = { plugins: [{ name: 'hand-placed' }], live: false }
		expect(m.enrichList(view)).toEqual(view)
	})
})
