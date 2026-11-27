/**
 * The desktop host's marketplace and plugin methods for sources that are fetched: a repository, a
 * hosted catalog file, a catalog entry that names a repository or an archive. Nothing here touches
 * the network: addresses are rewritten to a local bare repository or to a fake server on 127.0.0.1
 * through the fetch module's test-only options, as `plugin-marketplace-remote.test.ts` does for
 * the command line. Real timers: Git is a real process.
 */

import { spawn } from 'node:child_process'
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type TestRepo, makeRepo } from '../__fixtures__/git-repo.js'
import {
	CATALOG,
	MANIFEST,
	makePlugin,
	skill,
	write,
	zipOf,
} from '../__fixtures__/plugin-source.js'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { type FetchOptions, createGitRunner } from '../integrations/plugins/fetch/git.js'
import { knownMarketplacesPath } from '../integrations/plugins/records.js'
import {
	DOWNLOAD_BLOCKED,
	MARKETPLACE_BLOCKED,
	sameVersionChanged,
} from '../integrations/plugins/remote-marketplace.js'
import {
	OP_PROGRESS_NOTIFICATION,
	PLUGIN_CANCELLED_MESSAGE,
	createDesktopPluginActions,
} from './desktop-host-plugins.js'

let root: string
let home: string
let cwd: string
let addresses: Map<string, string>
let rewrites: string[]
let notes: { method: string; params: Record<string, unknown> }[]
let blocked: string[]
let runner: FetchOptions['runner']
let server: Server
let base: string
let served: Map<string, { type: string; body: Buffer | string }>

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), 'namzu-host-remote-'))
	home = join(root, 'home')
	cwd = realpathSync(mkdirSync(join(root, 'proj'), { recursive: true }) ?? join(root, 'proj'))
	mkdirSync(home, { recursive: true })
	addresses = new Map()
	rewrites = []
	notes = []
	blocked = []
	runner = undefined
	served = new Map()
	server = createServer((request, response) => {
		const hit = served.get(request.url ?? '')
		if (hit === undefined) return void response.writeHead(404).end()
		response.writeHead(200, { 'content-type': hit.type }).end(hit.body)
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
	server.closeAllConnections()
	await new Promise<void>((resolve) => server.close(() => resolve()))
	removeTempDir(root)
})

const actions = () =>
	createDesktopPluginActions({
		cwd,
		home,
		pal: () => false,
		isTrusted: () => true,
		notify: (method, params) => notes.push({ method, params }),
		loadingOn: () => true,
		enableLoading: () => 'Plugin loading is now on.',
		blockedMarketplaces: () => blocked,
		fetch: {
			allowFileProtocol: true,
			allowLoopbackHttp: true,
			rewriteUrl: (url) => {
				rewrites.push(url)
				return addresses.get(url) ?? 'file:///namzu-test-nothing-here.git'
			},
			...(runner !== undefined ? { runner } : {}),
		},
	})
type Host = ReturnType<typeof actions>

const TEAM = 'https://github.com/acme/team-tools.git'
const REMOTE_ONE = 'https://github.com/acme/remote-one.git'
const add = (m: Host, source: string, extra: Record<string, unknown> = {}) =>
	m.methods['namzu/marketplaces/add']({
		source,
		scope: 'user',
		accepted: 'marketplace-v1',
		...extra,
	}) as Promise<Record<string, any>>
const update = (m: Host, params: Record<string, unknown> = {}) =>
	m.methods['namzu/marketplaces/update'](params) as Promise<{ results: Record<string, any>[] }>
const plan = (m: Host, id: string, extra: Record<string, unknown> = {}) =>
	m.methods['namzu/plugins/plan']({ id, scope: 'user', ...extra }) as Promise<Record<string, any>>
const knownJson = (): Record<string, any> =>
	JSON.parse(readFileSync(knownMarketplacesPath(join(home, '.namzu')), 'utf8'))
const stagingLeft = (): number => {
	try {
		return readdirSync(join(home, '.namzu', 'plugins', '.staging')).length
	} catch {
		return 0
	}
}
const pluginFiles = (name: string, version: string) => ({
	[MANIFEST]: { name, version, description: `The ${name} plugin.` },
	'skills/s/SKILL.md': skill('s'),
})

/** A marketplace repository with one folder plugin and one entry that names a repository of its own. */
function teamRepo(name = 'team'): TestRepo {
	const repo = makeRepo(root, name)
	makePlugin(join(repo.work, 'plugins/ledger'), 'ledger', { files: pluginFiles('ledger', '1.0.0') })
	write(repo.work, {
		[CATALOG]: {
			name: 'team-tools',
			owner: { name: 'Acme Tools' },
			plugins: [
				{ name: 'ledger', source: './plugins/ledger' },
				{ name: 'npm-one', source: { source: 'npm', package: 'x' } },
				{ name: 'remote-one', source: { source: 'github', repo: 'acme/remote-one' } },
			],
		},
	})
	repo.commit({})
	return repo
}
function remoteOneRepo(version = '1.0.0'): TestRepo {
	const repo = makeRepo(root, 'remote-one')
	write(repo.work, pluginFiles('remote-one', version))
	repo.commit({})
	return repo
}

describe('namzu/marketplaces/preview, for an address', () => {
	it('says what will be added from the text alone, and what the settings block', () => {
		const m = actions()
		const view = (source: string) =>
			m.methods['namzu/marketplaces/preview']({ source }) as Record<string, any>
		expect(view('acme/tools#main')).toMatchObject({
			kind: 'github',
			remote: true,
			description: 'Will add github.com/acme/tools (branch or tag main)',
		})
		expect(view('acme/tools').description).toBe('Will add github.com/acme/tools (default branch)')
		expect(view('acme/tools').blocked).toBeUndefined()
		expect(view('https://example.test/m.json')).toMatchObject({ kind: 'https', remote: true })
		expect(view('git@git.example.com:acme/x.git')).toMatchObject({ kind: 'git', remote: true })
		for (const list of [
			['acme/tools'],
			['acme/*'],
			['github.com'],
			['https://github.com/ACME/tools.git'],
		]) {
			blocked = list
			expect(view('acme/tools').blocked, list.join()).toBe(MARKETPLACE_BLOCKED)
		}
		// A folder on this computer is its own consent and is never in the list.
		blocked = ['*']
		expect(view(root).blocked).toBeUndefined()
		expect(rewrites).toEqual([])
	})
})

describe('namzu/marketplaces/add, for an address', () => {
	it('fetches aside, reports its phases, records the yes as the desktop’s and leaves no staging', async () => {
		const repo = teamRepo()
		addresses.set(TEAM, repo.url)
		const m = actions()
		const added = await add(m, 'acme/team-tools', { opId: 'op-market-one' })
		expect(added).toMatchObject({ name: 'team-tools', plugins: 3, outcome: 'added' })
		expect(added.warnings.join(' ')).toContain('1 of its plugins cannot be installed here')
		expect(
			notes.filter((n) => n.method === OP_PROGRESS_NOTIFICATION).map((n) => n.params.phase),
		).toEqual(['checking', 'downloading', 'reading'])
		expect(knownJson()['team-tools']).toMatchObject({
			source: { source: 'github', repo: 'acme/team-tools' },
			autoUpdate: false,
			consent: { by: 'desktop', notice: 'marketplace-v1' },
		})
		expect(knownJson()['team-tools'].commit).toMatch(/^[0-9a-f]{40}$/)
		expect(stagingLeft()).toBe(0)
		const listed = (await m.methods['namzu/marketplaces/list']({})) as { marketplaces: any[] }
		expect(listed.marketplaces[0]).toMatchObject({
			name: 'team-tools',
			kind: 'github',
			source: 'github.com/acme/team-tools',
			plugins: 3,
		})
		const available = (await m.methods['namzu/marketplaces/available']({
			marketplace: 'team-tools',
		})) as { plugins: any[] }
		const byName = Object.fromEntries(available.plugins.map((p) => [p.name, p]))
		expect(byName.ledger.installable).toBe(true)
		expect(byName['remote-one'].installable).toBe(true)
		expect(byName['npm-one'].installable).toBe(false)
		// The same address again changes nothing; another place for the same name is refused.
		expect((await add(m, 'acme/team-tools')).outcome).toBe('already-added')
		addresses.set('https://github.com/fork/team-tools.git', teamRepo('fork').url)
		await expect(add(m, 'fork/team-tools')).rejects.toThrow('already added from another place')
		expect(stagingLeft()).toBe(0)
	})

	it('refuses a blocked address before anything is fetched, and a repository that is not a marketplace', async () => {
		blocked = ['acme/*']
		const m = actions()
		await expect(add(m, 'acme/team-tools')).rejects.toThrow(MARKETPLACE_BLOCKED)
		expect(rewrites).toEqual([])
		blocked = []
		const plain = makeRepo(root, 'plain')
		plain.commit({ 'README.md': 'nothing here' })
		addresses.set('https://github.com/acme/plain.git', plain.url)
		await expect(add(m, 'acme/plain')).rejects.toThrow('is not a marketplace')
		await expect(add(m, 'acme/missing')).rejects.toThrow('not found or not accessible')
		await expect(add(m, 'acme/tools#-x')).rejects.toThrow('not a branch, tag or commit name')
		expect(stagingLeft()).toBe(0)
	})

	it('reads a hosted catalog file over https', async () => {
		served.set('/marketplace.json', {
			type: 'application/json',
			body: JSON.stringify({
				name: 'hosted',
				plugins: [
					{ name: 'rel', source: './plugins/rel' },
					{ name: 'arch', source: { source: 'archive', url: 'https://example.test/a.zip' } },
				],
			}),
		})
		addresses.set('https://example.test/marketplace.json', `${base}/marketplace.json`)
		const m = actions()
		const added = await add(m, 'https://example.test/marketplace.json')
		expect(added).toMatchObject({ name: 'hosted', plugins: 2, outcome: 'added' })
		expect(knownJson().hosted.source).toEqual({
			source: 'url',
			url: 'https://example.test/marketplace.json',
		})
		await expect(plan(m, 'rel@hosted')).rejects.toThrow('a hosted catalog file has no folders')
	})

	it('stops a fetch the person cancelled: Git is killed, the staging folder goes, nothing is recorded', async () => {
		let pid: number | undefined
		let started!: () => void
		const running = new Promise<void>((resolve) => {
			started = resolve
		})
		// A Git that never finishes: the step ends only because the cancel kills it.
		runner = createGitRunner({
			spawn: (_command, _args, options) => {
				const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options)
				pid = child.pid
				started()
				return child as never
			},
		})
		const m = actions()
		const pending = add(m, 'acme/team-tools', { opId: 'op-cancel-one' })
		const settled = expect(pending).rejects.toThrow(PLUGIN_CANCELLED_MESSAGE)
		await running
		expect(m.methods['namzu/ops/cancel']({ opId: 'op-cancel-one' })).toEqual({ cancelled: true })
		await settled
		expect(pid).toBeDefined()
		expect(() => process.kill(pid as number, 0)).toThrow()
		expect(stagingLeft()).toBe(0)
		expect(() => knownJson()).toThrow()
	})
})

describe('namzu/marketplaces/update, for an address', () => {
	it('fetches the new commit, says it is current when it is, and does not move a pinned commit', async () => {
		const repo = teamRepo()
		addresses.set(TEAM, repo.url)
		const m = actions()
		await add(m, 'acme/team-tools')
		const first = knownJson()['team-tools'].commit
		expect((await update(m)).results).toEqual([
			expect.objectContaining({ name: 'team-tools', outcome: 'up-to-date', plugins: 3 }),
		])
		makePlugin(join(repo.work, 'plugins/extra'), 'extra', { files: pluginFiles('extra', '1.0.0') })
		const catalog = JSON.parse(readFileSync(join(repo.work, CATALOG), 'utf8'))
		catalog.plugins.push({ name: 'extra', source: './plugins/extra' })
		writeFileSync(join(repo.work, CATALOG), JSON.stringify(catalog))
		const next = repo.commit({})
		const updated = await update(m, { name: 'team-tools', opId: 'op-update-one' })
		expect(updated.results[0]).toMatchObject({
			name: 'team-tools',
			outcome: 'updated',
			plugins: 4,
			message: `updated ${first.slice(0, 7)} to ${next.slice(0, 7)} (1 new, 0 changed)`,
		})
		expect(knownJson()['team-tools'].commit).toBe(next)
		expect(
			notes.filter((n) => n.params.opId === 'op-update-one').map((n) => n.params.phase),
		).toEqual(['checking', 'downloading'])
		expect(stagingLeft()).toBe(0)
		// Pinned to a commit: never fetched again, so a later commit is not taken.
		const pinned = actions()
		await pinned.methods['namzu/marketplaces/remove']({ name: 'team-tools', confirm: true })
		await add(pinned, `acme/team-tools#${first}`)
		repo.commit({ 'later.txt': 'later' })
		const before = rewrites.length
		expect((await update(pinned)).results[0]).toMatchObject({
			outcome: 'pinned',
			message: `pinned at ${first.slice(0, 7)}`,
		})
		expect(rewrites.length).toBe(before)
		expect(knownJson()['team-tools'].commit).toBe(first)
	})

	it('says a blocked marketplace is not refreshed', async () => {
		const repo = teamRepo()
		addresses.set(TEAM, repo.url)
		const m = actions()
		await add(m, 'acme/team-tools')
		blocked = ['github.com/acme/*']
		const before = rewrites.length
		const row = (await update(m)).results[0]
		expect(row).toMatchObject({ outcome: 'failed' })
		expect(row?.error).toContain('turned off in your settings')
		expect(rewrites.length).toBe(before)
	})
})

describe('namzu/plugins, for a catalog entry that is fetched', () => {
	it('plans and installs a github entry with the same digest flow, and refuses a blocked one before any download', async () => {
		const team = teamRepo()
		const one = remoteOneRepo()
		addresses.set(TEAM, team.url)
		addresses.set(REMOTE_ONE, one.url)
		const m = actions()
		await add(m, 'acme/team-tools')
		const before = rewrites.length
		blocked = ['acme/remote-one']
		await expect(plan(m, 'remote-one@team-tools')).rejects.toThrow(DOWNLOAD_BLOCKED)
		blocked = ['github.com/acme/team-tools']
		await expect(plan(m, 'remote-one@team-tools')).rejects.toThrow(DOWNLOAD_BLOCKED)
		expect(rewrites.length).toBe(before)
		blocked = []
		const shown = await plan(m, 'remote-one@team-tools', { opId: 'op-plan-one' })
		expect(shown).toMatchObject({ id: 'remote-one@team-tools', version: '1.0.0' })
		expect(notes.filter((n) => n.params.opId === 'op-plan-one').map((n) => n.params.phase)).toEqual(
			['checking', 'downloading'],
		)
		await expect(
			m.methods['namzu/plugins/install']({
				planId: shown.planId,
				digest: 'f'.repeat(64),
				scope: 'user',
				consent: true,
			}),
		).rejects.toThrow('What it does changed')
		const done = (await m.methods['namzu/plugins/install']({
			planId: shown.planId,
			digest: shown.digest,
			scope: 'user',
			consent: true,
		})) as Record<string, any>
		expect(done).toMatchObject({ id: 'remote-one@team-tools', outcome: 'installed' })
		expect(stagingLeft()).toBe(0)
	})

	it('plans an archive entry, checking its digest', async () => {
		const zip = zipOf(pluginFiles('packed', '1.0.0'))
		served.set('/packed.zip', { type: 'application/zip', body: zip })
		addresses.set('https://example.test/packed.zip', `${base}/packed.zip`)
		const dir = join(root, 'arch-market')
		write(dir, {
			[CATALOG]: {
				name: 'arch',
				plugins: [
					{ name: 'packed', source: { source: 'archive', url: 'https://example.test/packed.zip' } },
					{
						name: 'wrong',
						source: {
							source: 'archive',
							url: 'https://example.test/packed.zip',
							sha256: '0'.repeat(64),
						},
					},
				],
			},
		})
		const m = actions()
		await add(m, dir)
		expect(await plan(m, 'packed@arch')).toMatchObject({ id: 'packed@arch', version: '1.0.0' })
		await expect(plan(m, 'wrong@arch')).rejects.toThrow('does not match the digest')
		// Only the plan that was shown holds a staging folder; the refused one left none.
		expect(stagingLeft()).toBe(m.plans.size)
	})

	it('checks for an update by refreshing only that plugin’s marketplace, and refuses the same version with other files', async () => {
		const team = teamRepo()
		const one = remoteOneRepo()
		const other = makeRepo(root, 'other')
		write(other.work, { [CATALOG]: { name: 'other', plugins: [] } })
		other.commit({})
		addresses.set(TEAM, team.url)
		addresses.set(REMOTE_ONE, one.url)
		addresses.set('https://github.com/acme/other.git', other.url)
		const m = actions()
		await add(m, 'acme/team-tools')
		await add(m, 'acme/other')
		const installPlan = await plan(m, 'remote-one@team-tools')
		await m.methods['namzu/plugins/install']({
			planId: installPlan.planId,
			digest: installPlan.digest,
			scope: 'user',
			consent: true,
		})
		const otherCommit = knownJson().other.commit
		const teamCommit = knownJson()['team-tools'].commit
		// The marketplace moves on, and the plugin's repository has a new version.
		team.commit({ 'notes.txt': 'a new commit' })
		other.commit({ 'notes.txt': 'a new commit' })
		one.commit({
			[MANIFEST]: JSON.stringify({ name: 'remote-one', version: '1.1.0', description: 'x' }),
		})
		const seen = rewrites.length
		const check = (await m.methods['namzu/plugins/update_check']({
			id: 'remote-one@team-tools',
		})) as Record<string, any>
		expect(check).toMatchObject({ current: '1.0.0', latest: '1.1.0', upToDate: false })
		expect(knownJson()['team-tools'].commit).not.toBe(teamCommit)
		expect(knownJson().other.commit).toBe(otherCommit)
		expect(rewrites.slice(seen)).not.toContain('https://github.com/acme/other.git')
		const applied = (await m.methods['namzu/plugins/update']({
			id: 'remote-one@team-tools',
			acceptDigest: undefined,
		})) as Record<string, any>
		expect(['updated', 'needs-consent']).toContain(applied.outcome)
		if (applied.outcome === 'needs-consent')
			await m.methods['namzu/plugins/update']({
				id: 'remote-one@team-tools',
				acceptDigest: applied.digest,
			})
		// New files under the version it already has cannot be applied.
		one.commit({ 'skills/s/SKILL.md': skill('s', 'allowed-tools: Read\n') })
		const same = sameVersionChanged('remote-one@team-tools', '1.1.0')
		await expect(
			m.methods['namzu/plugins/update']({ id: 'remote-one@team-tools' }),
		).rejects.toThrow(same)
		await expect(
			m.methods['namzu/plugins/update_check']({ id: 'remote-one@team-tools' }),
		).rejects.toThrow(same)
		expect(stagingLeft()).toBe(0)
	})

	it('stops a plan whose download was cancelled and leaves nothing behind', async () => {
		const team = teamRepo()
		addresses.set(TEAM, team.url)
		const m = actions()
		await add(m, 'acme/team-tools')
		let pid: number | undefined
		let started!: () => void
		const running = new Promise<void>((resolve) => {
			started = resolve
		})
		runner = createGitRunner({
			spawn: (_command, _args, options) => {
				const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options)
				pid = child.pid
				started()
				return child as never
			},
		})
		const hung = actions()
		const pending = plan(hung, 'remote-one@team-tools', { opId: 'op-plan-cancel' })
		const settled = expect(pending).rejects.toThrow(PLUGIN_CANCELLED_MESSAGE)
		await running
		hung.methods['namzu/ops/cancel']({ opId: 'op-plan-cancel' })
		await settled
		expect(() => process.kill(pid as number, 0)).toThrow()
		expect(stagingLeft()).toBe(0)
		expect(hung.plans.size).toBe(0)
	})
})
