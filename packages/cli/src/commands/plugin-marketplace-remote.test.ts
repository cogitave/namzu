import {
	existsSync,
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

import { type TestRepo, git, makeRepo } from '../__fixtures__/git-repo.js'
import {
	CATALOG,
	MANIFEST,
	makePlugin,
	skill,
	write,
	zipOf,
} from '../__fixtures__/plugin-source.js'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { recordLayerPath } from '../integrations/plugins/enabled-records.js'
import type { FetchOptions } from '../integrations/plugins/fetch/git.js'
import { installedPluginsPath, knownMarketplacesPath } from '../integrations/plugins/records.js'
import { type PluginInstallDeps, runMarketplace, runPluginInstall } from './plugin-install.js'

let root: string
let home: string
let cwd: string
let now = new Date('2026-11-27T10:00:00.000Z')
/** Every address a command may fetch, mapped to a local repository or the fake server. Anything else goes nowhere. */
let addresses: Map<string, string>
let rewrites: string[]
let server: Server
let base: string
let served: Map<string, { type: string; body: Buffer | string }>

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), 'namzu-remote-market-'))
	home = join(root, 'home')
	cwd = realpathSync(mkdirSync(join(root, 'app'), { recursive: true }) ?? join(root, 'app'))
	mkdirSync(home, { recursive: true })
	now = new Date('2026-11-27T10:00:00.000Z')
	addresses = new Map()
	rewrites = []
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

const fetchOptions = (): FetchOptions => ({
	allowFileProtocol: true,
	allowLoopbackHttp: true,
	rewriteUrl: (url) => {
		rewrites.push(url)
		return addresses.get(url) ?? 'file:///namzu-test-nothing-here.git'
	},
})

interface Options {
	interactive?: boolean
	answers?: boolean[]
	blocked?: string[]
	loadingOn?: boolean
}
interface Result {
	code: number
	out: string
	err: string
	json: () => Record<string, any>
	asked: string[]
}

async function exec(
	fn: (deps: PluginInstallDeps) => Promise<number>,
	options: Options = {},
): Promise<Result> {
	let out = ''
	let err = ''
	const asked: string[] = []
	const answers = [...(options.answers ?? [])]
	const deps: PluginInstallDeps = {
		out: (t) => {
			out += t
		},
		err: (t) => {
			err += t
		},
		cwd: () => cwd,
		namzuHome: home,
		isTrusted: () => true,
		loadingOn: options.loadingOn ?? true,
		interactive: options.interactive ?? false,
		ask: async (q) => {
			asked.push(q)
			return answers.shift() ?? false
		},
		now: () => now,
		enableLoading: () => 'Plugin loading is on.',
		blockedMarketplaces: options.blocked ?? [],
		fetch: fetchOptions(),
	}
	const code = await fn(deps)
	return { code, out, err, json: () => JSON.parse(out), asked }
}

const market = (args: string[], o?: Options) => exec((deps) => runMarketplace(args, deps), o)
const plugin = (verb: 'install' | 'uninstall' | 'update' | 'prune', args: string[], o?: Options) =>
	exec((deps) => runPluginInstall(verb, args, deps), o)

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const known = () => readJson(knownMarketplacesPath(home))
const installed = (): Record<string, any[]> =>
	existsSync(installedPluginsPath(home)) ? readJson(installedPluginsPath(home)).plugins : {}

function catalog(entries: unknown[], name = 'team-tools') {
	return { [CATALOG]: { name, owner: { name: 'Acme Tools' }, plugins: entries } }
}

/** A repository that is a marketplace: a catalog and two relative plugins, on branch main. */
function teamRepo(name = 'team'): { repo: TestRepo; head: string } {
	const repo = makeRepo(root, name)
	makePlugin(join(repo.work, 'plugins/ledger'), 'ledger')
	makePlugin(join(repo.work, 'plugins/notes'), 'notes', {
		files: {
			[MANIFEST]: { name: 'notes', version: '2.0.0', description: 'Notes.' },
			'skills/jot/SKILL.md': skill('jot'),
		},
	})
	write(
		repo.work,
		catalog([
			{ name: 'ledger', source: './plugins/ledger' },
			{ name: 'notes', source: './plugins/notes', version: '2.0.0' },
			{ name: 'npm-one', source: { source: 'npm', package: 'x' } },
			{ name: 'remote-one', source: { source: 'github', repo: 'acme/remote-one' } },
		]),
	)
	const head = repo.commit({})
	return { repo, head }
}

const GITHUB = 'https://github.com/acme/team-tools.git'

describe('namzu plugin marketplace add, from a repository', () => {
	it('clones into Namzu’s own folder, shows the consent text with owner, count and commit, and records it', async () => {
		const { repo, head } = teamRepo()
		addresses.set(GITHUB, repo.url)
		const shown = await market(['add', 'acme/team-tools', '--ref', 'main', '--yes'])
		expect(shown.code, shown.err).toBe(0)
		expect(shown.out).toContain(
			'Added marketplace "team-tools" (4 plugins, 1 cannot be installed here).',
		)
		await market(['remove', 'team-tools', '--yes'])
		const result = await market(['add', 'acme/team-tools', '--ref', 'main', '--yes', '--json'])
		expect(result.code, result.err).toBe(0)
		expect(result.json()).toMatchObject({
			outcome: 'added',
			name: 'team-tools',
			source: { source: 'github', repo: 'acme/team-tools', ref: 'main' },
			plugins: 4,
			notInstallable: 1,
			commit: head,
			lfsPointers: 0,
			submodules: 0,
		})
		expect(shown.err).toContain('Add marketplace "team-tools" from github.com/acme/team-tools?')
		expect(shown.err).toContain('Add only marketplaces you trust.')
		expect(shown.err).toContain('Owner:    Acme Tools')
		expect(shown.err).toContain('Plugins:  4 (1 cannot be installed here)')
		expect(shown.err).toContain(`Commit:   ${head.slice(0, 7)}  (main)`)
		expect(shown.err).toContain('You will see what a plugin does before you install it.')
		const entry = known()['team-tools']
		expect(entry).toMatchObject({
			source: { source: 'github', repo: 'acme/team-tools', ref: 'main' },
			installLocation: join(home, 'plugins', 'marketplaces', 'team-tools'),
			autoUpdate: false,
			commit: head,
			consent: { by: 'cli', notice: 'marketplace-v1', at: now.toISOString() },
		})
		// A marketplace clone keeps .git so it can be updated; nothing in staging is left.
		expect(existsSync(join(entry.installLocation, '.git'))).toBe(true)
		expect(existsSync(join(entry.installLocation, CATALOG))).toBe(true)
		expect(
			existsSync(join(home, 'plugins', '.staging'))
				? readdirCount(join(home, 'plugins', '.staging'))
				: 0,
		).toBe(0)
		const settings = readJson(recordLayerPath('user', { home, cwd }))
		expect(settings.extraKnownMarketplaces['team-tools'].source.repo).toBe('acme/team-tools')
	})

	it('adds from an https github address, and from a scp-like address (mapped to local repositories)', async () => {
		const { repo } = teamRepo()
		addresses.set(GITHUB, repo.url)
		addresses.set('git@git.example.com:acme/team-tools.git', repo.url)
		const first = await market(['add', 'https://github.com/acme/team-tools', '--yes', '--json'])
		expect(first.json().source).toEqual({ source: 'github', repo: 'acme/team-tools' })
		await market(['remove', 'team-tools', '--yes'])
		const second = await market([
			'add',
			'git@git.example.com:acme/team-tools.git',
			'--yes',
			'--json',
		])
		expect(second.json().source).toEqual({
			source: 'git',
			url: 'git@git.example.com:acme/team-tools.git',
		})
	})

	it('asks first when a person is there, and a no leaves nothing behind', async () => {
		const { repo } = teamRepo()
		addresses.set(GITHUB, repo.url)
		const no = await market(['add', 'acme/team-tools'], { interactive: true, answers: [false] })
		expect(no.code).toBe(1)
		expect(no.asked).toEqual(['Add this marketplace?'])
		expect(no.out).toContain('Add marketplace "team-tools" from github.com/acme/team-tools?')
		expect(existsSync(knownMarketplacesPath(home))).toBe(false)
		expect(existsSync(join(home, 'plugins', 'marketplaces', 'team-tools'))).toBe(false)
		const yes = await market(['add', 'acme/team-tools'], { interactive: true, answers: [true] })
		expect(yes.code).toBe(0)
		expect(Object.keys(known())).toEqual(['team-tools'])
	})

	it('with no terminal and no --yes exits 75 before anything is fetched', async () => {
		const result = await market(['add', 'acme/team-tools'])
		expect(result.code).toBe(75)
		expect(result.err).toBe(
			'A marketplace can run code. Add --yes to confirm that you trust github.com/acme/team-tools.\n',
		)
		expect(rewrites).toEqual([])
	})

	it('--dry-run does no I/O and prints the source and the notice', async () => {
		const result = await market(['add', 'acme/team-tools#main', '--dry-run', '--json'])
		expect(result.code).toBe(0)
		expect(result.json()).toMatchObject({
			outcome: 'dry-run',
			source: { source: 'github', repo: 'acme/team-tools', ref: 'main' },
		})
		expect(rewrites).toEqual([])
		expect(existsSync(knownMarketplacesPath(home))).toBe(false)
	})

	it('checks plugins.blockedMarketplaces before any download, exit 77', async () => {
		for (const blocked of [['acme/team-tools'], ['acme/*'], ['github.com']]) {
			const result = await market(['add', 'acme/team-tools', '--yes'], { blocked })
			expect(result.code, blocked.join()).toBe(77)
			expect(result.err).toBe('Adding this marketplace is turned off in your settings.\n')
		}
		expect(rewrites).toEqual([])
		// A folder on this computer is its own consent and is not an address.
		const dir = join(root, 'folder-market')
		write(dir, catalog([], 'folder-market'))
		expect((await market(['add', dir, '--yes'], { blocked: ['*'] })).code).toBe(0)
	})

	it('says plainly: not a marketplace, repository not found, a bad flag, and refuses the same name from another source', async () => {
		const plain = makeRepo(root, 'plain')
		plain.commit({ 'README.md': 'nothing here' })
		addresses.set('https://github.com/acme/plain.git', plain.url)
		const not = await market(['add', 'acme/plain', '--yes'])
		expect(not.code).toBe(65)
		expect(not.err).toContain('is not a marketplace')
		const gone = await market(['add', 'acme/missing', '--yes'])
		expect(gone.code).toBe(66)
		expect(gone.err).toContain('not found or not accessible')
		expect((await market(['add', 'acme/team-tools', '--ref', '-x', '--yes'])).code).toBe(64)
		expect((await market(['add', 'acme/team-tools', '--sparse', '../x', '--yes'])).code).toBe(64)
		expect((await market(['add', './folder', '--ref', 'main'])).code).toBe(64)
		expect((await market(['list', '--ref', 'main'])).code).toBe(64)
		expect((await plugin('install', ['x', '--sparse', 'a'])).code).toBe(64)
		const { repo } = teamRepo()
		addresses.set(GITHUB, repo.url)
		expect((await market(['add', 'acme/team-tools', '--yes'])).code).toBe(0)
		const same = await market(['add', 'acme/team-tools', '--yes', '--json'])
		expect(same.json().outcome).toBe('already-added')
		const other = teamRepo('other')
		addresses.set('https://github.com/fork/team-tools.git', other.repo.url)
		const clash = await market(['add', 'fork/team-tools', '--yes'])
		expect(clash.code).toBe(65)
		expect(clash.err).toContain('already added from another place')
	})

	it('sparse: only the catalog folder and the named folders are checked out', async () => {
		const { repo } = teamRepo()
		addresses.set(GITHUB, repo.url)
		const result = await market([
			'add',
			'acme/team-tools',
			'--sparse',
			'plugins/ledger',
			'--yes',
			'--json',
		])
		expect(result.code, result.err).toBe(0)
		const where = known()['team-tools'].installLocation
		expect(existsSync(join(where, 'plugins/ledger'))).toBe(true)
		expect(existsSync(join(where, 'plugins/notes'))).toBe(false)
		expect(known()['team-tools'].source.sparsePaths).toEqual(['plugins/ledger'])
	})

	it('reports Git LFS pointers and submodules a repository holds, and fetches neither', async () => {
		const repo = makeRepo(root, 'heavy')
		write(repo.work, catalog([], 'heavy'))
		repo.commit({
			'asset.bin': `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 99\n`,
		})
		const sub = makeRepo(root, 'subm')
		sub.commit({ 'x.txt': 'x' })
		git(repo.work, 'submodule', 'add', '--quiet', sub.url, 'vendor/sub')
		git(repo.work, 'commit', '--quiet', '-m', 'submodule')
		git(repo.work, 'push', '--quiet', 'origin', 'HEAD:main')
		addresses.set('https://github.com/acme/heavy.git', repo.url)
		const result = await market(['add', 'acme/heavy', '--yes', '--json'])
		expect(result.code, result.err).toBe(0)
		expect(result.json()).toMatchObject({ lfsPointers: 1, submodules: 1 })
		expect(result.json().warnings.join(' ')).toContain('Git LFS')
		expect(existsSync(join(known().heavy.installLocation, 'vendor/sub/x.txt'))).toBe(false)
	})
})

describe('namzu plugin marketplace add, from a hosted catalog file', () => {
	it('reads an https marketplace.json; relative entries have nothing behind them', async () => {
		served.set('/marketplace.json', {
			type: 'application/json',
			body: JSON.stringify({
				name: 'hosted',
				owner: { name: 'Host Co' },
				plugins: [
					{ name: 'rel', source: './plugins/rel' },
					{ name: 'arch', source: { source: 'archive', url: 'https://example.test/a.zip' } },
				],
			}),
		})
		addresses.set('https://example.test/marketplace.json', `${base}/marketplace.json`)
		const result = await market(['add', 'https://example.test/marketplace.json', '--yes', '--json'])
		expect(result.code, result.err).toBe(0)
		expect(result.json()).toMatchObject({
			name: 'hosted',
			source: { source: 'url' },
			plugins: 2,
			notInstallable: 1,
			commit: null,
		})
		const rel = await plugin('install', ['rel@hosted', '--yes'])
		expect(rel.code).toBe(69)
		expect(rel.err).toContain('a hosted catalog file has no folders')
		// A reply that is not a catalog, and a page that is missing.
		served.set('/bad.json', { type: 'application/json', body: '{"nope":1}' })
		addresses.set('https://example.test/bad.json', `${base}/bad.json`)
		expect((await market(['add', 'https://example.test/bad.json', '--yes'])).code).toBe(65)
		addresses.set('https://example.test/gone.json', `${base}/gone.json`)
		expect((await market(['add', 'https://example.test/gone.json', '--yes'])).code).toBe(66)
	})
})

describe('namzu plugin marketplace update', () => {
	it('refreshes a clone, says what is new and changed, and never installs or updates a plugin', async () => {
		const { repo, head } = teamRepo()
		addresses.set(GITHUB, repo.url)
		await market(['add', 'acme/team-tools', '--yes'])
		await plugin('install', ['notes@team-tools', '--yes'])
		const beforePlugin = installed()['notes@team-tools']?.[0]
		makePlugin(join(repo.work, 'plugins/extra'), 'extra', {
			files: {
				[MANIFEST]: { name: 'extra', version: '1.0.0', description: 'E.' },
				'skills/e/SKILL.md': skill('e'),
			},
		})
		const catalogPath = join(repo.work, CATALOG)
		const text = JSON.parse(readFileSync(catalogPath, 'utf8'))
		text.plugins.push({ name: 'extra', source: './plugins/extra' })
		text.plugins.find((p: { name: string }) => p.name === 'notes').version = '2.1.0'
		writeFileSync(catalogPath, JSON.stringify(text))
		const next = repo.commit({})
		const result = await market(['update', '--json'])
		expect(result.code, result.err).toBe(0)
		const row = result.json().results[0]
		expect(row).toMatchObject({
			name: 'team-tools',
			outcome: 'updated',
			from: head,
			to: next,
			newPlugins: ['extra'],
			changedPlugins: ['notes'],
			message: `updated ${head.slice(0, 7)} to ${next.slice(0, 7)} (1 new, 1 changed)`,
		})
		expect(row.newer).toEqual([{ id: 'notes@team-tools', installed: '2.0.0', available: '2.1.0' }])
		expect(known()['team-tools'].commit).toBe(next)
		expect(existsSync(join(known()['team-tools'].installLocation, 'plugins/extra'))).toBe(true)
		// A plugin was neither installed nor updated by it.
		expect(installed()['extra@team-tools']).toBeUndefined()
		expect(installed()['notes@team-tools']?.[0].version).toBe(beforePlugin.version)
		const text2 = await market(['update', 'team-tools'])
		expect(text2.out).toContain('team-tools: already up to date')
		const shown = await market(['update', '--json'])
		expect(shown.json().results[0].outcome).toBe('up-to-date')
	})

	it('prints the plain sentences, and does not move a marketplace pinned at a commit', async () => {
		const { repo, head } = teamRepo()
		addresses.set(GITHUB, repo.url)
		await market(['add', `acme/team-tools#${head}`, '--yes'])
		repo.commit({ 'later.txt': 'a later commit' })
		const pinned = await market(['update'])
		expect(pinned.code).toBe(0)
		expect(pinned.out).toBe(`team-tools: pinned at ${head.slice(0, 7)}\n`)
		expect(known()['team-tools'].commit).toBe(head)
		expect(existsSync(join(known()['team-tools'].installLocation, 'later.txt'))).toBe(false)
	})

	it('one failure does not stop the rest; the exit is 69 and each failure is named', async () => {
		const a = teamRepo('a')
		const b = makeRepo(root, 'b')
		write(b.work, catalog([], 'second'))
		b.commit({})
		addresses.set(GITHUB, a.repo.url)
		addresses.set('https://github.com/acme/second.git', b.url)
		await market(['add', 'acme/team-tools', '--yes'])
		await market(['add', 'acme/second', '--yes'])
		// The first is gone from where it came from; the second has news.
		addresses.delete(GITHUB)
		b.commit({ 'news.txt': 'news' })
		const result = await market(['update'])
		expect(result.code).toBe(69)
		expect(result.out).toContain('second: updated')
		expect(result.out).toContain('team-tools: ')
		expect(result.err).toContain('1 could not be updated: team-tools.')
		expect(existsSync(join(known().second.installLocation, 'news.txt'))).toBe(true)
		// A marketplace that is not added.
		expect((await market(['update', 'ghost'])).code).toBe(66)
	})

	it('re-reads a folder marketplace, honours the block list, and refuses a changed name', async () => {
		const dir = join(root, 'folder-market')
		write(dir, catalog([{ name: 'p', source: './p' }], 'folder-market'))
		await market(['add', dir, '--yes'])
		const reread = await market(['update'])
		expect(reread.out).toContain('folder-market: re-read (1 plugin)')
		const { repo } = teamRepo()
		addresses.set(GITHUB, repo.url)
		await market(['add', 'acme/team-tools', '--yes'])
		const blocked = await market(['update', 'team-tools'], { blocked: ['acme/team-tools'] })
		expect(blocked.code).toBe(69)
		expect(blocked.out).toContain('refreshing it is turned off in your settings')
		write(repo.work, catalog([], 'renamed'))
		repo.commit({ 'x.txt': 'x' })
		const renamed = await market(['update', 'team-tools'])
		expect(renamed.code).toBe(69)
		expect(renamed.out).toContain('now calls itself "renamed"')
		expect(known()['team-tools'].commit).not.toBe(git(repo.work, 'rev-parse', 'HEAD'))
	})

	it('re-fetches a hosted catalog and says what changed', async () => {
		const body = (names: string[]) => ({
			type: 'application/json',
			body: JSON.stringify({
				name: 'hosted',
				owner: { name: 'H' },
				plugins: names.map((name) => ({
					name,
					source: { source: 'archive', url: 'https://example.test/a.zip' },
				})),
			}),
		})
		served.set('/m.json', body(['one']))
		addresses.set('https://example.test/m.json', `${base}/m.json`)
		await market(['add', 'https://example.test/m.json', '--yes'])
		expect((await market(['update', '--json'])).json().results[0].outcome).toBe('up-to-date')
		served.set('/m.json', body(['one', 'two']))
		const changed = (await market(['update', '--json'])).json().results[0]
		expect(changed).toMatchObject({
			outcome: 'updated',
			newPlugins: ['two'],
			message: 'updated (1 new, 0 changed)',
		})
	})
})

describe('namzu plugin marketplace remove and list, for a downloaded marketplace', () => {
	it('lists the address, and removes Namzu’s own copy but never a folder the person pointed at', async () => {
		const { repo } = teamRepo()
		addresses.set(GITHUB, repo.url)
		await market(['add', 'acme/team-tools', '--yes'])
		const dir = join(root, 'folder-market')
		write(dir, catalog([], 'folder-market'))
		await market(['add', dir, '--yes'])
		const list = await market(['list'])
		expect(list.out).toContain('team-tools  github.com/acme/team-tools  4 plugins, 0 installed')
		const clone = known()['team-tools'].installLocation
		const preview = await market(['remove', 'team-tools'], { interactive: true, answers: [false] })
		expect(preview.out).toContain('The copy Namzu downloaded goes too.')
		expect(existsSync(clone)).toBe(true)
		expect((await market(['remove', 'team-tools', '--yes'])).code).toBe(0)
		expect(existsSync(clone)).toBe(false)
		expect((await market(['remove', 'folder-market', '--yes'])).code).toBe(0)
		expect(existsSync(join(dir, CATALOG))).toBe(true)
	})
})

describe('namzu plugin install, from entries that are downloaded', () => {
	async function addTeam(): Promise<{ repo: TestRepo; head: string }> {
		const made = teamRepo()
		addresses.set(GITHUB, made.repo.url)
		const added = await market(['add', 'acme/team-tools', '--yes'])
		expect(added.code, added.err).toBe(0)
		return made
	}

	it('installs a folder entry of a cloned marketplace, shows the commit, and records it', async () => {
		const { head } = await addTeam()
		const dry = await plugin('install', ['ledger@team-tools', '--dry-run'])
		expect(dry.out).toContain(`Install ledger 1.0.0 from team-tools (commit ${head.slice(0, 7)})?`)
		const result = await plugin('install', ['ledger@team-tools', '--yes', '--json'])
		expect(result.code, result.err).toBe(0)
		expect(result.json()).toMatchObject({ outcome: 'installed', commit: head, version: '1.0.0' })
		expect(installed()['ledger@team-tools']?.[0].gitCommitSha).toBe(head)
	})

	it('installs a plugin from a repository of its own (github entry), a git url entry and a git-subdir entry, without .git', async () => {
		const solo = makeRepo(root, 'solo')
		makePlugin(join(solo.work, '.'), 'solo', {
			files: {
				[MANIFEST]: { name: 'solo', version: '1.0.0', description: 'S.' },
				'skills/s/SKILL.md': skill('s'),
			},
		})
		const soloHead = solo.commit({})
		const mono = makeRepo(root, 'mono')
		makePlugin(join(mono.work, 'plugins/deep'), 'deep', {
			files: {
				[MANIFEST]: { name: 'deep', version: '3.0.0', description: 'D.' },
				'skills/d/SKILL.md': skill('d'),
			},
		})
		makePlugin(join(mono.work, 'plugins/other'), 'other')
		mono.commit({})
		const viaUrl = makeRepo(root, 'viaurl')
		makePlugin(join(viaUrl.work, '.'), 'viaurl', {
			files: {
				[MANIFEST]: { name: 'viaurl', version: '1.0.0', description: 'U.' },
				'skills/u/SKILL.md': skill('u'),
			},
		})
		viaUrl.commit({})
		addresses.set('https://github.com/acme/solo.git', solo.url)
		addresses.set('https://example.test/mono.git', mono.url)
		addresses.set('https://example.test/viaurl.git', viaUrl.url)
		const dir = join(root, 'cat')
		write(
			dir,
			catalog(
				[
					{ name: 'solo', source: { source: 'github', repo: 'acme/solo' } },
					{
						name: 'deep',
						source: {
							source: 'git-subdir',
							url: 'https://example.test/mono.git',
							path: 'plugins/deep',
							ref: 'main',
						},
					},
					{ name: 'viaurl', source: { source: 'url', url: 'https://example.test/viaurl.git' } },
					{
						name: 'escape',
						source: { source: 'git-subdir', url: 'https://example.test/mono.git', path: '../x' },
					},
					{
						name: 'missing',
						source: {
							source: 'git-subdir',
							url: 'https://example.test/mono.git',
							path: 'plugins/absent',
						},
					},
				],
				'remote-cat',
			),
		)
		await market(['add', dir, '--yes'])
		for (const name of ['solo', 'deep', 'viaurl']) {
			const result = await plugin('install', [`${name}@remote-cat`, '--yes', '--json'])
			expect(result.code, `${name}: ${result.err}`).toBe(0)
			const where = installed()[`${name}@remote-cat`]?.[0].installPath as string
			expect(existsSync(join(where, '.git')), name).toBe(false)
			expect(existsSync(join(where, MANIFEST)), name).toBe(true)
		}
		const deepRoot = installed()['deep@remote-cat']?.[0].installPath as string
		expect(existsSync(join(deepRoot, 'skills/d/SKILL.md'))).toBe(true)
		expect(installed()['solo@remote-cat']?.[0].gitCommitSha).toBe(soloHead)
		const climbs = await plugin('install', ['escape@remote-cat', '--yes'])
		expect(climbs.code).toBe(65)
		const missing = await plugin('install', ['missing@remote-cat', '--yes'])
		expect(missing.code).toBe(65)
		expect(missing.err).toContain('has no folder')
	})

	it('holds a plugin at its sha pin after the branch moves on, and a pin that does not exist stops the install', async () => {
		const solo = makeRepo(root, 'solo')
		const pluginFiles = (version: string) => ({
			[MANIFEST]: JSON.stringify({ name: 'solo', version, description: 'S.' }),
			'skills/s/SKILL.md': skill('s'),
		})
		const first = solo.commit(pluginFiles('1.0.0'))
		solo.commit(pluginFiles('2.0.0'))
		addresses.set('https://github.com/acme/solo.git', solo.url)
		const dir = join(root, 'cat')
		write(
			dir,
			catalog(
				[
					{ name: 'solo', source: { source: 'github', repo: 'acme/solo', sha: first } },
					{ name: 'lost', source: { source: 'github', repo: 'acme/solo', sha: 'e'.repeat(40) } },
				],
				'pins',
			),
		)
		await market(['add', dir, '--yes'])
		const ok = await plugin('install', ['solo@pins', '--yes', '--json'])
		expect(ok.json()).toMatchObject({ version: '1.0.0', commit: first })
		const lost = await plugin('install', ['lost@pins', '--yes'])
		expect(lost.code).toBe(66)
		expect(installed()['lost@pins']).toBeUndefined()
	})

	it('installs an archive entry over https: pinned shows no warning, unpinned says so, a wrong digest installs nothing', async () => {
		const { createHash } = await import('node:crypto')
		const files = {
			[MANIFEST]: { name: 'zipped', version: '1.0.0', description: 'Z.' },
			'skills/z/SKILL.md': skill('z'),
		}
		const zip = zipOf(files)
		const unpinnedZip = zipOf({
			...files,
			[MANIFEST]: { name: 'unpinned', version: '1.0.0', description: 'Z.' },
		})
		served.set('/u.zip', { type: 'application/zip', body: unpinnedZip })
		addresses.set('https://example.test/u.zip', `${base}/u.zip`)
		const sha = createHash('sha256').update(zip).digest('hex')
		served.set('/z.zip', { type: 'application/zip', body: zip })
		addresses.set('https://example.test/z.zip', `${base}/z.zip`)
		const dir = join(root, 'cat')
		write(
			dir,
			catalog(
				[
					{
						name: 'zipped',
						source: { source: 'archive', url: 'https://example.test/z.zip', sha256: sha },
					},
					{ name: 'unpinned', source: { source: 'archive', url: 'https://example.test/u.zip' } },
					{
						name: 'wrong',
						source: {
							source: 'archive',
							url: 'https://example.test/z.zip',
							sha256: 'a'.repeat(64),
						},
					},
				],
				'archives',
			),
		)
		await market(['add', dir, '--yes'])
		const pinned = await plugin('install', ['zipped@archives', '--dry-run', '--json'])
		expect(pinned.json().surface.unpinnedDownload).toBe(false)
		const unpinned = await plugin('install', ['unpinned@archives', '--dry-run'])
		expect(unpinned.out).toContain('This download is not pinned to a digest.')
		expect(unpinned.code, unpinned.err).toBe(0)
		const wrong = await plugin('install', ['wrong@archives', '--yes'])
		expect(wrong.code).toBe(65)
		expect(wrong.err).toContain('does not match the digest')
		expect(installed()['wrong@archives']).toBeUndefined()
		const done = await plugin('install', ['zipped@archives', '--yes'])
		expect(done.code, done.err).toBe(0)
		expect(installed()['zipped@archives']).toHaveLength(1)
	})

	it('refuses an archive that climbs out of its folder, and leaves nothing in staging', async () => {
		const { makeZip } = await import('../__fixtures__/plugin-source.js')
		const bad = makeZip([
			{
				name: MANIFEST,
				data: Buffer.from('{"name":"evil","version":"1.0.0"}'),
			},
			{ name: '../../escape.txt', data: Buffer.from('x') },
		])
		served.set('/evil.zip', { type: 'application/zip', body: bad })
		addresses.set('https://example.test/evil.zip', `${base}/evil.zip`)
		const dir = join(root, 'cat')
		write(
			dir,
			catalog(
				[{ name: 'evil', source: { source: 'archive', url: 'https://example.test/evil.zip' } }],
				'bad',
			),
		)
		await market(['add', dir, '--yes'])
		const result = await plugin('install', ['evil@bad', '--yes'])
		expect(result.code).toBe(65)
		expect(existsSync(join(root, 'escape.txt'))).toBe(false)
		expect(readdirCount(join(home, 'plugins', '.staging'))).toBe(0)
	})

	it('never downloads from a blocked marketplace or a blocked entry source', async () => {
		await addTeam()
		const before = rewrites.length
		const blockedMarket = await plugin('install', ['ledger@team-tools', '--yes'], {
			blocked: ['acme/team-tools'],
		})
		// A local entry of a blocked marketplace is not a download, and still installs; a remote entry is refused first.
		expect(blockedMarket.code).toBe(0)
		const remoteEntry = await plugin('install', ['remote-one@team-tools', '--yes'], {
			blocked: ['acme/remote-one'],
		})
		expect(remoteEntry.code).toBe(77)
		expect(remoteEntry.err).toContain('turned off in your settings')
		const viaMarket = await plugin('install', ['remote-one@team-tools', '--yes'], {
			blocked: ['acme/team-tools'],
		})
		expect(viaMarket.code).toBe(77)
		expect(rewrites.length).toBe(before)
	})

	it('names the plain reasons: entry repository not found, and a source Namzu never runs', async () => {
		await addTeam()
		const gone = await plugin('install', ['remote-one@team-tools', '--yes'])
		expect(gone.code).toBe(66)
		expect(gone.err).toContain('not found or not accessible')
		const npm = await plugin('install', ['npm-one@team-tools', '--yes'])
		expect(npm.code).toBe(69)
		expect(npm.err).toContain('does not install')
	})
})

describe('namzu plugin update, for a plugin that was downloaded', () => {
	it('applies at once when nothing that runs changed, and asks again when it did', async () => {
		const solo = makeRepo(root, 'solo')
		const base1 = {
			[MANIFEST]: JSON.stringify({ name: 'solo', version: '1.0.0', description: 'S.' }),
			'skills/s/SKILL.md': skill('s'),
		}
		solo.commit(base1)
		addresses.set('https://github.com/acme/solo.git', solo.url)
		const dir = join(root, 'cat')
		write(dir, catalog([{ name: 'solo', source: { source: 'github', repo: 'acme/solo' } }], 'live'))
		await market(['add', dir, '--yes'])
		expect((await plugin('install', ['solo@live', '--yes'])).code).toBe(0)
		expect((await plugin('update', ['solo@live', '--json'])).json().outcome).toBe('up-to-date')

		// Version bump and a changed skill text: nothing that runs.
		const next = solo.commit({
			[MANIFEST]: JSON.stringify({ name: 'solo', version: '1.1.0', description: 'S.' }),
			'skills/s/SKILL.md': skill('s', ''),
			'notes.md': 'changelog',
		})
		const safe = await plugin('update', ['solo@live', '--json'])
		expect(safe.code, safe.err).toBe(0)
		expect(safe.json()).toMatchObject({
			outcome: 'updated',
			from: '1.0.0',
			to: '1.1.0',
			commit: next,
		})
		expect(installed()['solo@live']?.[0]).toMatchObject({ version: '1.1.0', gitCommitSha: next })

		// A new hook: what runs changed, so the preview comes back with the change marked.
		const hooked = solo.commit({
			[MANIFEST]: JSON.stringify({ name: 'solo', version: '1.2.0', description: 'S.' }),
			'hooks/hooks.json': JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							matcher: 'Bash',
							hooks: [{ type: 'command', command: '${NAMZU_PLUGIN_ROOT}/run.sh' }],
						},
					],
				},
			}),
			'run.sh': { content: '#!/bin/sh\nexit 0\n', mode: 0o755 },
		})
		const asked = await plugin('update', ['solo@live'])
		expect(asked.code).toBe(75)
		expect(asked.out).toContain('Update solo@live from 1.1.0 to 1.2.0')
		expect(asked.out).toContain(`(commit ${hooked.slice(0, 7)})`)
		expect(asked.out).toContain('What changed since the version you have:')
		expect(installed()['solo@live']?.[0].version).toBe('1.1.0')
		const stale = await plugin('update', ['solo@live', '--accept-surface', 'f'.repeat(64)])
		expect(stale.code).toBe(75)
		expect(stale.err).toContain('changed since you read it')
		const digest = (await plugin('update', ['solo@live', '--dry-run', '--json'])).json()
			.surfaceSha256
		const accepted = await plugin('update', ['solo@live', '--accept-surface', digest])
		expect(accepted.code, accepted.err).toBe(0)
		expect(installed()['solo@live']?.[0]).toMatchObject({ version: '1.2.0', gitCommitSha: hooked })
		// The old copy stays, marked, for a running conversation.
		expect(
			existsSync(join(home, 'plugins', 'cache', 'live', 'solo', '1.1.0', '.orphaned_at')),
		).toBe(true)
	})
})

function readdirCount(path: string): number {
	try {
		return readdirSync(path).length
	} catch {
		return 0
	}
}
