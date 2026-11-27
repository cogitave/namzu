import { execFile } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	CATALOG,
	MANIFEST,
	makeMarketplace,
	makePlugin,
	skill,
	write,
	zipOf,
} from '../__fixtures__/plugin-source.js'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { recordLayerPath } from '../integrations/plugins/enabled-records.js'
import { type InstallStep, SimulatedCrash } from '../integrations/plugins/install.js'
import {
	installedPluginsPath,
	knownMarketplacesPath,
	pluginCacheFolder,
} from '../integrations/plugins/records.js'
import { type PluginInstallDeps, runMarketplace, runPluginInstall } from './plugin-install.js'
import { type PluginRecordVerb, runPluginRecords } from './plugin-records.js'

const here = dirname(fileURLToPath(import.meta.url))
let root: string
let home: string
let cwd: string
let now = new Date('2026-11-27T10:00:00.000Z')
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-plugin-install-'))
	home = join(root, 'home')
	cwd = realpathSync(mkdirSync(join(root, 'app'), { recursive: true }) ?? join(root, 'app'))
	mkdirSync(home, { recursive: true })
	now = new Date('2026-11-27T10:00:00.000Z')
})
afterEach(() => removeTempDir(root))

interface Options {
	trusted?: boolean
	loadingOn?: boolean
	interactive?: boolean
	answers?: boolean[]
	faults?: (step: InstallStep) => void
}
interface Result {
	code: number
	out: string
	err: string
	json: () => Record<string, any>
	asked: string[]
	loadingEnabled: number
}

async function exec(
	fn: (deps: PluginInstallDeps) => Promise<number>,
	options: Options = {},
): Promise<Result> {
	let out = ''
	let err = ''
	const asked: string[] = []
	let loadingEnabled = 0
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
		isTrusted: () => options.trusted ?? true,
		loadingOn: options.loadingOn ?? true,
		interactive: options.interactive ?? false,
		ask: async (q) => {
			asked.push(q)
			return answers.shift() ?? false
		},
		now: () => now,
		enableLoading: () => {
			loadingEnabled++
			return 'Plugin loading is on.'
		},
		...(options.faults ? { faults: options.faults } : {}),
	}
	const code = await fn(deps)
	return { code, out, err, json: () => JSON.parse(out), asked, loadingEnabled }
}

const plugin = (verb: 'install' | 'uninstall' | 'update' | 'prune', args: string[], o?: Options) =>
	exec((deps) => runPluginInstall(verb, args, deps), o)
const market = (args: string[], o?: Options) => exec((deps) => runMarketplace(args, deps), o)
const records = (verb: PluginRecordVerb, args: string[]) =>
	exec((deps) => runPluginRecords(verb, args, deps))

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const installed = () => readJson(installedPluginsPath(home)).plugins as Record<string, any[]>
const userSettings = () => readJson(recordLayerPath('user', { home, cwd }))

/** A marketplace `team-tools` with `ledger` (every runnable kind) and a skills-only `notes`. */
function team(): string {
	const dir = join(root, 'team-tools')
	makePlugin(join(dir, 'plugins/ledger'), 'ledger')
	makePlugin(join(dir, 'plugins/notes'), 'notes', {
		files: {
			[MANIFEST]: { name: 'notes', version: '2.0.0', description: 'Notes.' },
			'skills/jot/SKILL.md': skill('jot'),
		},
	})
	makeMarketplace(dir, 'team-tools', [
		{ name: 'ledger', source: './plugins/ledger' },
		{ name: 'notes', source: './plugins/notes' },
		{ name: 'remote-one', source: { source: 'github', repo: 'acme/remote-one' } },
		{ name: 'npm-one', source: { source: 'npm', package: 'x' } },
	])
	return dir
}

async function addTeam(): Promise<string> {
	const dir = team()
	const added = await market(['add', dir, '--json'])
	expect(added.code).toBe(0)
	return dir
}

describe('namzu plugin marketplace add', () => {
	it('registers a folder in place, records the consent and the user declaration', async () => {
		const dir = team()
		const result = await market(['add', dir, '--json'])
		expect(result.code).toBe(0)
		expect(result.json()).toMatchObject({
			command: 'plugin marketplace add',
			outcome: 'added',
			name: 'team-tools',
			plugins: 4,
			notInstallable: 2,
		})
		expect(result.err).toContain('Add only marketplaces you trust')
		const known = readJson(knownMarketplacesPath(home))
		expect(known['team-tools']).toMatchObject({
			source: { source: 'directory', path: realpathSync(dir) },
			installLocation: realpathSync(dir),
			autoUpdate: false,
			consent: { by: 'cli', notice: 'marketplace-v1', at: now.toISOString() },
		})
		expect(userSettings().extraKnownMarketplaces['team-tools'].source.source).toBe('directory')
		// Registered in place: nothing was copied under the plugin folder.
		expect(existsSync(join(home, 'plugins', 'marketplaces'))).toBe(false)
	})

	it('registers a .json catalog file, resolving entries against its folder', async () => {
		const dir = team()
		const file = join(dir, CATALOG)
		const result = await market(['add', file, '--json'])
		expect(result.json()).toMatchObject({ outcome: 'added', source: { source: 'file' } })
		const install = await plugin('install', ['ledger@team-tools', '--dry-run', '--json'])
		expect(install.json().outcome).toBe('dry-run')
	})

	it('is a no-op for the same source and refuses the same name from another place', async () => {
		const dir = await addTeam()
		const again = await market(['add', dir, '--json'])
		expect(again.code).toBe(0)
		expect(again.json().outcome).toBe('already-added')
		const other = join(root, 'other')
		makeMarketplace(other, 'team-tools', [])
		const clash = await market(['add', other])
		expect(clash.code).toBe(65)
		expect(clash.err).toContain('already added from another place')
	})

	it('refuses reserved, namzu and official-looking names', async () => {
		for (const name of [
			'local-uploads',
			'inline',
			'builtin',
			'synced',
			'namzu',
			'namzu-tools',
			'claude-tools',
			'healthcare',
			'Team Tools',
		]) {
			const dir = join(root, `m-${name.replace(/\W/g, '_')}`)
			makeMarketplace(dir, name, [])
			const result = await market(['add', dir])
			expect(result.code, name).toBe(65)
		}
		expect(existsSync(knownMarketplacesPath(home))).toBe(false)
	})

	it('exits 64 for an address that is not one and for the forms refused before any I/O', async () => {
		for (const bad of [
			'',
			'http://example.com/m.json',
			'file:///tmp/m',
			'https://user:pw@example.com/m.json',
			'https://github.com/a/b/tree/main/x',
			'nonsense words',
		]) {
			const result = await market(['add', bad])
			expect(result.code, bad).toBe(64)
		}
		expect((await market(['add', 'https://example.com/m.json?x=1'])).code).toBe(64)
	})

	it('says a remote address needs a download, exit 69, and writes nothing', async () => {
		for (const remote of [
			'acme/team-tools',
			'https://github.com/acme/team-tools',
			'git@github.com:acme/team-tools.git',
		]) {
			const result = await market(['add', remote])
			expect(result.code, remote).toBe(69)
			expect(result.err).toContain('needs a download')
		}
		expect(existsSync(knownMarketplacesPath(home))).toBe(false)
	})

	it('exits 66 for a path that is not there or holds no catalog, and 65 for a bad catalog', async () => {
		expect((await market(['add', join(root, 'nope')])).code).toBe(66)
		const empty = join(root, 'empty')
		mkdirSync(empty)
		expect((await market(['add', empty])).code).toBe(66)
		write(join(root, 'bad'), { [CATALOG]: '{ not json' })
		expect((await market(['add', join(root, 'bad')])).code).toBe(65)
		write(join(root, 'noname'), { [CATALOG]: { plugins: [] } })
		expect((await market(['add', join(root, 'noname')])).code).toBe(65)
		write(join(root, 'text'), { 'a.txt': 'x' })
		expect((await market(['add', join(root, 'text', 'a.txt')])).code).toBe(64)
	})

	it('--dry-run prints the source and the notice and writes nothing', async () => {
		const dir = team()
		const result = await market(['add', dir, '--dry-run'])
		expect(result.code).toBe(0)
		expect(result.out).toContain('Add only marketplaces you trust')
		expect(existsSync(knownMarketplacesPath(home))).toBe(false)
	})

	it('writes a project declaration only in a trusted folder, and says 77 otherwise', async () => {
		const dir = team()
		expect((await market(['add', dir, '--scope', 'project'], { trusted: false })).code).toBe(77)
		expect(existsSync(knownMarketplacesPath(home))).toBe(false)
		expect((await market(['add', dir, '--scope', 'project'])).code).toBe(0)
		expect(
			readJson(recordLayerPath('project', { home, cwd })).extraKnownMarketplaces['team-tools'],
		).toBeDefined()
	})

	it('skips a catalog entry without a name or source and keeps the rest, saying so', async () => {
		const dir = join(root, 'sloppy')
		makePlugin(join(dir, 'plugins/ok'), 'ok')
		write(dir, {
			[CATALOG]: {
				name: 'sloppy',
				owner: { name: 'x' },
				plugins: [
					{ name: 'ok', source: './plugins/ok' },
					{ name: 'ok', source: './plugins/ok' },
					{ source: './x' },
					{ name: 'nosource' },
					'text',
				],
			},
		})
		const result = await market(['add', dir, '--json'])
		expect(result.json().plugins).toBe(1)
		expect(result.json().warnings.length).toBe(4)
	})
})

describe('namzu plugin marketplace list and remove', () => {
	it('lists what is added with counts, as text and JSON', async () => {
		await addTeam()
		const json = (await market(['list', '--json'])).json()
		expect(json.marketplaces).toEqual([
			expect.objectContaining({ name: 'team-tools', plugins: 4, installed: 0, autoUpdate: false }),
		])
		expect((await market(['list'])).out).toContain('team-tools')
		const empty = await exec((deps) => runMarketplace(['list'], deps))
		expect(empty.code).toBe(0)
	})

	it('shows marketplaces a project declares and has not added', async () => {
		write(cwd, {
			'.namzu/settings.json': {
				extraKnownMarketplaces: { theirs: { source: { source: 'directory', path: '/x' } } },
			},
		})
		const json = (await market(['list', '--json'])).json()
		expect(json.declaredByProject).toEqual([
			expect.objectContaining({ name: 'theirs', declaredBy: 'project' }),
		])
	})

	it('removes a marketplace with its installs, keeps their data, and never touches its folder', async () => {
		const dir = await addTeam()
		await plugin('install', ['ledger@team-tools', '--yes'])
		const data = join(home, 'plugins', 'data', 'ledger@team-tools')
		mkdirSync(data, { recursive: true })
		writeFileSync(join(data, 'state.txt'), 'mine')
		const refused = await market(['remove', 'team-tools'])
		expect(refused.code).toBe(75)
		expect(refused.out).toContain('ledger@team-tools')
		const result = await market(['remove', 'team-tools', '--yes', '--json'])
		expect(result.code).toBe(0)
		expect(result.json()).toMatchObject({
			outcome: 'removed',
			uninstalled: ['ledger@team-tools (user)'],
		})
		expect(readJson(knownMarketplacesPath(home))).toEqual({})
		expect(installed()).toEqual({})
		expect(userSettings().enabledPlugins ?? {}).toEqual({})
		expect(userSettings().extraKnownMarketplaces).toEqual({})
		expect(readFileSync(join(data, 'state.txt'), 'utf8')).toBe('mine')
		expect(existsSync(join(dir, CATALOG))).toBe(true)
		expect(existsSync(join(pluginCacheFolder(home), 'team-tools', 'ledger'))).toBe(false)
	})

	it('asks before removing in a terminal, and exits 66 for one that is not added', async () => {
		await addTeam()
		const no = await market(['remove', 'team-tools'], { interactive: true, answers: [false] })
		expect(no.code).toBe(1)
		expect(readJson(knownMarketplacesPath(home))['team-tools']).toBeDefined()
		const yes = await market(['remove', 'team-tools'], { interactive: true, answers: [true] })
		expect(yes.code).toBe(0)
		expect((await market(['remove', 'team-tools', '--yes'])).code).toBe(66)
		expect((await market(['remove', 'local-uploads', '--yes'])).code).toBe(64)
	})
})

describe('namzu plugin install: the preview is the consent surface', () => {
	it('lists every runnable kind, with the digest to accept, and installs nothing without a yes', async () => {
		await addTeam()
		const result = await plugin('install', ['ledger@team-tools'])
		expect(result.code).toBe(75)
		const text = result.out
		expect(text).toContain('Install ledger 1.0.0 from team-tools?')
		expect(text).toContain('Skills (1):')
		expect(text).toContain('Commands (1): /ledger__close')
		expect(text).toContain('Agents (1):')
		// hook: event, matcher and the command it runs
		expect(text).toMatch(
			/hook\s+pre_tool_use Bash\s+->\s+\$\{NAMZU_PLUGIN_ROOT\}\/scripts\/guard\.sh/,
		)
		// local server: command, args and environment names
		expect(text).toMatch(/server\s+ledger-db\s+->\s+node \$\{NAMZU_PLUGIN_ROOT\}\/server\.js/)
		expect(text).toContain('environment: MODE')
		// remote server: origin and what it would send
		expect(text).toMatch(/server\s+ledger-api\s+->\s+https:\/\/mcp\.example\.com/)
		expect(text).toContain('would send $LEDGER_TOKEN')
		// script with its exec bit
		expect(text).toMatch(/script\s+scripts\/guard\.sh\s+\(\d+ B, executable\)/)
		expect(text).toContain('script    server.js')
		// pre-approved tools
		expect(text).toContain('Pre-approves tools: skill reconcile allows Bash(git log:*), Read')
		expect(text).toMatch(/Surface: sha256:[0-9a-f]{64}/)
		expect(result.err).toContain('no terminal to ask on')
		expect(existsSync(installedPluginsPath(home))).toBe(false)
		expect(existsSync(join(pluginCacheFolder(home)))).toBe(false)
		// Staging was cleaned up.
		const staging = join(home, 'plugins', '.staging')
		expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([])
	})

	it('--dry-run gives the whole surface as JSON and exits 0', async () => {
		await addTeam()
		const result = await plugin('install', ['ledger@team-tools', '--dry-run', '--json'])
		expect(result.code).toBe(0)
		const json = result.json()
		expect(json).toMatchObject({
			command: 'plugin install',
			outcome: 'dry-run',
			id: 'ledger@team-tools',
			scope: 'user',
			version: '1.0.0',
			commit: null,
			layout: 'common',
		})
		expect(Object.keys(json.surface).sort()).toEqual(
			[
				'allowedTools',
				'fileHooks',
				'hooks',
				'mcpLocal',
				'mcpRemote',
				'modules',
				'scripts',
				'unpinnedDownload',
			].sort(),
		)
		expect(json.surface.hooks).toEqual([
			{
				event: 'pre_tool_use',
				matcher: 'Bash',
				type: 'command',
				run: '${NAMZU_PLUGIN_ROOT}/scripts/guard.sh',
			},
		])
		expect(json.surface.mcpLocal[0]).toMatchObject({
			name: 'ledger-db',
			command: 'node',
			args: ['${NAMZU_PLUGIN_ROOT}/server.js'],
			env: { MODE: 'test' },
		})
		expect(json.surface.mcpRemote[0]).toMatchObject({
			name: 'ledger-api',
			origin: 'https://mcp.example.com',
			sendsEnv: ['LEDGER_TOKEN'],
			headers: ['Authorization'],
		})
		expect(json.surface.allowedTools).toEqual([
			{ kind: 'skill', name: 'reconcile', tools: ['Bash(git log:*)', 'Read'] },
		])
		expect(json.surface.scripts.map((s: { path: string }) => s.path)).toEqual([
			'scripts/guard.sh',
			'server.js',
		])
		expect(json.surfaceSha256).toMatch(/^[0-9a-f]{64}$/)
		expect(existsSync(installedPluginsPath(home))).toBe(false)
	})

	it('lists the hooks that skills, commands and agents carry in their front matter', async () => {
		const dir = join(root, 'hooky')
		makePlugin(dir, 'hooky', {
			files: {
				[MANIFEST]: { name: 'hooky', version: '1.0.0', description: 'Hooks.' },
				'skills/guarded/SKILL.md': skill(
					'guarded',
					'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./check.sh\n',
				),
				'commands/run.md': '---\nallowed-tools: Bash(make:*)\n---\nRun.\n',
			},
		})
		const json = (await plugin('install', [dir, '--dry-run', '--json'])).json()
		expect(json.surface.fileHooks).toEqual([
			expect.objectContaining({
				kind: 'skill',
				name: 'guarded',
				event: 'pre_tool_use',
				run: './check.sh',
			}),
		])
		expect(json.surface.allowedTools).toEqual([
			{ kind: 'command', name: 'run', tools: ['Bash(make:*)'] },
		])
	})

	it('names a module in the surface until the module reader declares what it does', async () => {
		const dir = join(root, 'modular')
		makePlugin(dir, 'modular', {
			files: {
				'plugin.json': {
					name: 'modular',
					version: '1.0.0',
					description: 'Modules.',
					hooks: ['hooks/mod.js'],
					skills: [],
				},
				'hooks/mod.js': 'export const hooks = []\n',
			},
		})
		const result = await plugin('install', [dir, '--dry-run'])
		expect(result.out).toMatch(
			/module\s+hooks\/mod\.js\s+\(JavaScript that runs inside the session/,
		)
		expect((await plugin('install', [dir, '--dry-run', '--json'])).json().surface.modules).toEqual([
			{ path: 'hooks/mod.js' },
		])
	})

	it('shows hostile text without its control characters', async () => {
		const dir = join(root, 'evil')
		makePlugin(dir, 'evil', {
			files: {
				[MANIFEST]: { name: 'evil', version: '1.0.0', description: 'x' },
				'hooks/hooks.json': {
					hooks: {
						PreToolUse: [{ hooks: [{ type: 'command', command: 'echo \u001b[2Jgone ‮evil' }] }],
					},
				},
			},
		})
		const result = await plugin('install', [dir, '--dry-run'])
		expect(result.out).not.toContain('\u001b')
		expect(result.out).not.toContain('‮')
	})
})

describe('namzu plugin install: consent', () => {
	it('--yes installs into the cache, with the manifest, the record and the recorded yes, in that tree', async () => {
		await addTeam()
		const result = await plugin('install', ['ledger@team-tools', '--yes', '--json'])
		expect(result.code).toBe(0)
		const json = result.json()
		expect(json).toMatchObject({
			outcome: 'installed',
			id: 'ledger@team-tools',
			scope: 'user',
			loading: 'on',
		})
		const folder = join(pluginCacheFolder(home), 'team-tools', 'ledger', '1.0.0')
		expect(existsSync(join(folder, MANIFEST))).toBe(true)
		expect(existsSync(join(folder, 'scripts/guard.sh'))).toBe(true)
		expect(statSync(join(folder, 'scripts/guard.sh')).mode & 0o111).not.toBe(0)
		expect(statSync(join(folder, 'server.js')).mode & 0o111).toBe(0)
		expect(
			statSync(join(home, 'plugins', '.install-manifests', 'ledger@team-tools.json')).mode & 0o077,
		).toBe(0)
		const manifest = readJson(join(home, 'plugins', '.install-manifests', 'ledger@team-tools.json'))
		expect(manifest).toMatchObject({
			version: 1,
			id: 'ledger@team-tools',
			surfaceSha256: json.surfaceSha256,
			consent: { scope: 'user', by: 'cli', nonInteractive: true },
		})
		expect(manifest.executable).toEqual(
			expect.arrayContaining([
				'scripts/guard.sh',
				'hooks/hooks.json',
				'server.js',
				MANIFEST,
				'skills/reconcile/SKILL.md',
			]),
		)
		expect(Object.keys(manifest.files).sort()).toEqual([...manifest.executable].sort())
		const record = installed()['ledger@team-tools']
		expect(record).toEqual([
			expect.objectContaining({
				scope: 'user',
				installPath: folder,
				version: '1.0.0',
				layout: 'common',
				surfaceSha256: json.surfaceSha256,
			}),
		])
		expect(userSettings().enabledPlugins).toEqual({ 'ledger@team-tools': true })
		// What the other commands say.
		const listed = (await records('list', ['--json'])).json()
		expect(listed.plugins[0]).toMatchObject({ id: 'ledger@team-tools', state: 'on' })
	})

	it('--accept-surface installs only the surface whose digest was shown', async () => {
		await addTeam()
		const digest = (await plugin('install', ['ledger@team-tools', '--dry-run', '--json'])).json()
			.surfaceSha256
		const wrong = await plugin('install', [
			'ledger@team-tools',
			'--accept-surface',
			'f'.repeat(64),
			'--json',
		])
		expect(wrong.code).toBe(75)
		expect(wrong.json()).toMatchObject({
			outcome: 'declined',
			message: expect.stringContaining('changed since you read it'),
		})
		expect(existsSync(installedPluginsPath(home))).toBe(false)
		const right = await plugin('install', [
			'ledger@team-tools',
			'--accept-surface',
			`sha256:${digest}`,
		])
		expect(right.code).toBe(0)
		expect(installed()['ledger@team-tools']).toBeDefined()
		expect(
			(await plugin('install', ['notes@team-tools', '--yes', '--accept-surface', digest])).code,
		).toBe(64)
	})

	it('asks in a terminal: yes installs, no leaves everything as it was', async () => {
		await addTeam()
		const no = await plugin('install', ['ledger@team-tools'], {
			interactive: true,
			answers: [false],
		})
		expect(no.code).toBe(1)
		expect(no.asked).toEqual(['Install?'])
		expect(no.out).toContain('Surface: sha256:')
		expect(existsSync(installedPluginsPath(home))).toBe(false)
		const yes = await plugin('install', ['ledger@team-tools'], {
			interactive: true,
			answers: [true],
		})
		expect(yes.code).toBe(0)
		expect(yes.out).toContain(
			'Installed ledger@team-tools 1.0.0 (scope: user). It loads in new conversations.',
		)
	})

	it('keeps standard output to one JSON object while prompting on standard error', async () => {
		await addTeam()
		const result = await plugin('install', ['ledger@team-tools', '--json'], {
			interactive: true,
			answers: [true],
		})
		expect(result.code).toBe(0)
		expect(result.json().outcome).toBe('installed')
		expect(result.err).toContain('Surface: sha256:')
	})

	it('offers to turn plugin loading on, never silently and never because of --yes', async () => {
		await addTeam()
		const quiet = await plugin('install', ['ledger@team-tools', '--yes', '--json'], {
			loadingOn: false,
		})
		expect(quiet.loadingEnabled).toBe(0)
		expect(quiet.json()).toMatchObject({
			loading: 'off',
			notes: [expect.stringContaining('namzu config set plugins.enabled true')],
		})
		await plugin('uninstall', ['ledger@team-tools', '--yes'])
		const asked = await plugin('install', ['ledger@team-tools'], {
			loadingOn: false,
			interactive: true,
			answers: [true, true],
		})
		expect(asked.asked).toEqual(['Install?', 'Plugin loading is off on this computer. Turn it on?'])
		expect(asked.loadingEnabled).toBe(1)
		expect(asked.out).toContain('Plugin loading is on.')
		await plugin('uninstall', ['ledger@team-tools', '--yes'])
		const flag = await plugin(
			'install',
			['ledger@team-tools', '--yes', '--enable-loading', '--json'],
			{ loadingOn: false },
		)
		expect(flag.loadingEnabled).toBe(1)
		expect(flag.json().loading).toBe('on')
	})

	it('says already installed, and does not ask again', async () => {
		await addTeam()
		await plugin('install', ['ledger@team-tools', '--yes'])
		const again = await plugin('install', ['ledger@team-tools', '--json'])
		expect(again.code).toBe(0)
		expect(again.json().outcome).toBe('already-installed')
		expect(again.asked).toEqual([])
	})
})

describe('namzu plugin install: sources', () => {
	it('installs a folder as name@local-uploads', async () => {
		const dir = makePlugin(join(root, 'mine'), 'mine')
		const result = await plugin('install', [dir, '--yes', '--json'])
		expect(result.json()).toMatchObject({ outcome: 'installed', id: 'mine@local-uploads' })
		expect(
			existsSync(join(pluginCacheFolder(home), 'local-uploads', 'mine', '1.0.0', MANIFEST)),
		).toBe(true)
		expect(
			readJson(join(home, 'plugins', '.install-manifests', 'mine@local-uploads.json'))
				.installedFrom,
		).toMatchObject({ marketplace: 'local-uploads', kind: 'folder' })
		expect(existsSync(knownMarketplacesPath(home))).toBe(false)
	})

	it('installs an archive, descending into one wrapping folder, and keeps exec bits only as written', async () => {
		const files = {
			'zipped/.claude-plugin/plugin.json': { name: 'zipped', version: '0.3.0', description: 'Z.' },
			'zipped/skills/s/SKILL.md': skill('s'),
			'zipped/run.sh': '#!/bin/sh\n',
			'__MACOSX/zipped/._x': 'junk',
		}
		const file = join(root, 'zipped.plugin')
		writeFileSync(file, zipOf(files, ['zipped/run.sh']))
		const result = await plugin('install', [file, '--yes', '--json'])
		expect(result.code).toBe(0)
		expect(result.json()).toMatchObject({ id: 'zipped@local-uploads', version: '0.3.0' })
		const folder = join(pluginCacheFolder(home), 'local-uploads', 'zipped', '0.3.0')
		expect(statSync(join(folder, 'run.sh')).mode & 0o111).not.toBe(0)
		expect(existsSync(join(folder, '._x'))).toBe(false)
		expect(result.json().surface.scripts).toEqual([
			expect.objectContaining({ path: 'run.sh', exec: true }),
		])
	})

	it('refuses unsafe archives, exit 65, and writes nothing', async () => {
		const cases: Record<string, Buffer> = {
			'a path that climbs out': zipOf({
				'../escape.txt': 'x',
				[MANIFEST]: { name: 'a', version: '1.0.0', description: 'x' },
			}),
			'two names that differ by case': zipOf({ 'A.txt': 'x', 'a.txt': 'y' }),
			'an absolute path': zipOf({ '/etc/x': 'x' }),
			'not a zip': Buffer.from('this is not a zip file at all, it is just text'),
		}
		for (const [label, bytes] of Object.entries(cases)) {
			const file = join(root, `bad-${label.length}.zip`)
			writeFileSync(file, bytes)
			const result = await plugin('install', [file, '--yes'])
			expect(result.code, label).toBe(65)
		}
		const bomb = join(root, 'bomb.zip')
		writeFileSync(
			bomb,
			zipOf({
				[MANIFEST]: { name: 'b', version: '1.0.0', description: 'x' },
				'big.bin': 'a'.repeat(400_000),
			}),
		)
		const bombed = await plugin('install', [bomb, '--yes'])
		expect(bombed.code).toBe(65)
		expect(bombed.err).toContain('expands more than')
		expect(existsSync(installedPluginsPath(home))).toBe(false)
		expect(existsSync(pluginCacheFolder(home))).toBe(false)
		expect((await plugin('install', [join(root, 'missing.zip'), '--yes'])).code).toBe(66)
	})

	it('does not copy a link inside a folder, and says so', async () => {
		const dir = makePlugin(join(root, 'linked'), 'linked')
		writeFileSync(join(root, 'outside.txt'), 'secret')
		symlinkSync(join(root, 'outside.txt'), join(dir, 'leak.txt'))
		const result = await plugin('install', [dir, '--yes', '--json'])
		expect(result.code).toBe(0)
		expect(
			existsSync(join(pluginCacheFolder(home), 'local-uploads', 'linked', '1.0.0', 'leak.txt')),
		).toBe(false)
		expect(result.json().findings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ level: 'ignored', code: 'symlink', field: 'leak.txt' }),
			]),
		)
	})

	it('refuses a folder that holds the Namzu home, and a folder with no plugin in it', async () => {
		expect((await plugin('install', [root, '--yes'])).code).toBe(65)
		const empty = join(root, 'nothing')
		mkdirSync(empty)
		expect((await plugin('install', [empty, '--yes'])).code).toBe(65)
	})

	it('reads a catalog entry that sets components inline (strict false) through the sidecar', async () => {
		const dir = join(root, 'inline-market')
		write(join(dir, 'plugins/bare'), {
			'skills/hello/SKILL.md': skill('hello'),
			'README.md': 'Bare.',
		})
		makeMarketplace(dir, 'inline-market', [
			{
				name: 'bare',
				source: './plugins/bare',
				extra: {
					strict: false,
					version: '1.1.0',
					description: 'Bare.',
					skills: ['./skills/hello'],
				},
			},
		])
		await market(['add', dir])
		const result = await plugin('install', ['bare@inline-market', '--yes', '--json'])
		expect(result.code).toBe(0)
		const folder = join(pluginCacheFolder(home), 'inline-market', 'bare', '1.1.0')
		expect(existsSync(join(folder, '.namzu-entry.json'))).toBe(true)
		const manifest = readJson(
			join(home, 'plugins', '.install-manifests', 'bare@inline-market.json'),
		)
		expect(manifest.executable).toContain('.namzu-entry.json')
	})

	it('drops a sidecar that came with the files', async () => {
		const dir = makePlugin(join(root, 'sneaky'), 'sneaky', {
			extra: { '.namzu-entry.json': { name: 'sneaky', skills: ['./x'] } },
		})
		const result = await plugin('install', [dir, '--yes', '--json'])
		expect(
			existsSync(
				join(pluginCacheFolder(home), 'local-uploads', 'sneaky', '1.0.0', '.namzu-entry.json'),
			),
		).toBe(false)
		expect(result.json().findings).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: 'sidecar-shipped' })]),
		)
	})
})

describe('namzu plugin install: resolving the argument', () => {
	it('resolves a bare name when one marketplace has it, and lists the choices when several do', async () => {
		await addTeam()
		const bare = await plugin('install', ['notes', '--dry-run', '--json'])
		expect(bare.json().id).toBe('notes@team-tools')
		const second = join(root, 'second')
		makePlugin(join(second, 'plugins/notes'), 'notes', {
			files: {
				[MANIFEST]: { name: 'notes', version: '9.0.0', description: 'n' },
				'skills/a/SKILL.md': skill('a'),
			},
		})
		makeMarketplace(second, 'second', [{ name: 'notes', source: './plugins/notes' }])
		await market(['add', second])
		const ambiguous = await plugin('install', ['notes', '--dry-run'])
		expect(ambiguous.code).toBe(64)
		expect(ambiguous.err).toContain('notes@second, notes@team-tools')
		expect((await plugin('install', ['notes@second', '--dry-run', '--json'])).json().version).toBe(
			'9.0.0',
		)
	})

	it('exits 66 for a plugin or marketplace that is not there, with the hint for a folder named like it', async () => {
		await addTeam()
		expect((await plugin('install', ['ghost@team-tools', '--yes'])).code).toBe(66)
		expect((await plugin('install', ['ghost@nowhere', '--yes'])).code).toBe(66)
		mkdirSync(join(cwd, 'mine'))
		const hint = await plugin('install', ['mine', '--yes'])
		expect(hint.code).toBe(66)
		expect(hint.err).toContain('./mine')
		expect((await plugin('install', ['x@local-uploads', '--yes'])).code).toBe(64)
		expect((await plugin('install', ['bad@', '--yes'])).code).toBe(64)
	})

	it('says why an entry cannot be installed here, exit 69', async () => {
		await addTeam()
		const remote = await plugin('install', ['remote-one@team-tools', '--yes'])
		expect(remote.code).toBe(69)
		expect(remote.err).toContain('cannot fetch yet')
		const npm = await plugin('install', ['npm-one@team-tools', '--yes'])
		expect(npm.code).toBe(69)
		expect(npm.err).toContain('does not install')
	})

	it('refuses an entry whose name is not the plugin’s, and a source that leaves the marketplace folder', async () => {
		const dir = join(root, 'liar')
		makePlugin(join(dir, 'plugins/real'), 'real')
		makeMarketplace(dir, 'liar', [
			{ name: 'fake', source: './plugins/real' },
			{ name: 'escape', source: '../team-tools' },
			{ name: 'abs', source: '/tmp' },
		])
		await market(['add', dir])
		const mismatch = await plugin('install', ['fake@liar', '--yes'])
		expect(mismatch.code).toBe(65)
		expect(mismatch.err).toContain('calls itself "real"')
		const escaped = await plugin('install', ['escape@liar', '--yes'])
		expect(escaped.code).toBe(65)
		expect(escaped.err).toContain('leaves the marketplace folder, which is not allowed')
		expect(escaped.err).not.toContain('file tools')
		expect((await plugin('install', ['abs@liar', '--yes'])).code).toBe(65)
	})

	it('takes only one argument, and no option that is not its own', async () => {
		expect((await plugin('install', [])).code).toBe(64)
		expect((await plugin('install', ['a', 'b'])).code).toBe(64)
		expect((await plugin('install', ['a', '--delete-data'])).code).toBe(64)
		expect((await plugin('install', ['a', '--marketplace', 'x'])).code).toBe(64)
		expect((await plugin('prune', ['--enable-loading'])).code).toBe(64)
	})
})

describe('namzu plugin install: scopes, names and versions', () => {
	it('writes a project record and the shared settings file in a trusted folder', async () => {
		await addTeam()
		const result = await plugin('install', [
			'ledger@team-tools',
			'--scope',
			'project',
			'--yes',
			'--json',
		])
		expect(result.code).toBe(0)
		expect(installed()['ledger@team-tools']).toEqual([
			expect.objectContaining({ scope: 'project', projectPath: cwd }),
		])
		expect(readJson(recordLayerPath('project', { home, cwd })).enabledPlugins).toEqual({
			'ledger@team-tools': true,
		})
	})

	it('writes this computer’s file for local scope, and exits 77 for a folder that is not trusted', async () => {
		await addTeam()
		expect(
			(
				await plugin('install', ['ledger@team-tools', '--scope', 'local', '--yes'], {
					trusted: false,
				})
			).code,
		).toBe(77)
		expect(
			(
				await plugin('install', ['ledger@team-tools', '--scope', 'project', '--yes'], {
					trusted: false,
				})
			).code,
		).toBe(77)
		expect(existsSync(installedPluginsPath(home))).toBe(false)
		expect((await plugin('install', ['ledger@team-tools', '--scope', 'local', '--yes'])).code).toBe(
			0,
		)
		expect(readJson(recordLayerPath('local', { home, cwd })).enabledPlugins).toEqual({
			'ledger@team-tools': true,
		})
	})

	it('shares one copy between scopes of one version, and refuses to hold two versions', async () => {
		const dir = await addTeam()
		await plugin('install', ['ledger@team-tools', '--yes'])
		const second = await plugin('install', [
			'ledger@team-tools',
			'--scope',
			'local',
			'--yes',
			'--json',
		])
		expect(second.code).toBe(0)
		const list = installed()['ledger@team-tools']
		expect(list.map((r) => r.scope).sort()).toEqual(['local', 'user'])
		expect(list[0].installPath).toBe(list[1].installPath)
		// The author raises the version: a third scope may not hold another copy.
		write(join(dir, 'plugins/ledger'), {
			[MANIFEST]: { name: 'ledger', version: '1.1.0', description: 'x' },
		})
		const conflict = await plugin('install', ['ledger@team-tools', '--scope', 'project', '--yes'])
		expect(conflict.code).toBe(65)
		expect(conflict.err).toContain('namzu plugin update ledger@team-tools')
		expect(installed()['ledger@team-tools']).toHaveLength(2)
	})

	it('refuses the same version with other contents', async () => {
		const dir = await addTeam()
		await plugin('install', ['ledger@team-tools', '--yes'])
		write(join(dir, 'plugins/ledger'), { 'server.js': '// changed\n' })
		const result = await plugin('install', ['ledger@team-tools', '--scope', 'local', '--yes'])
		expect(result.code).toBe(65)
		expect(result.err).toContain(
			'This version already exists with other contents; nothing was changed.',
		)
	})

	it('refuses a name another plugin already uses: installed, or placed by hand', async () => {
		const dir = await addTeam()
		await plugin('install', ['ledger@team-tools', '--yes'])
		const other = makePlugin(join(root, 'elsewhere/ledger'), 'ledger')
		const clash = await plugin('install', [other, '--yes'])
		expect(clash.code).toBe(65)
		expect(clash.err).toContain(
			'The name "ledger" is already used by ledger@team-tools. Remove it first, or ask the author to rename this plugin.',
		)
		write(join(home, 'plugins', 'hand'), {
			'plugin.json': { name: 'notes', version: '1.0.0', description: 'by hand', skills: [] },
		})
		const byHand = await plugin('install', ['notes@team-tools', '--yes'])
		expect(byHand.code).toBe(65)
		expect(byHand.err).toContain('is already used by the plugin folder')
		expect(dir).toBeTruthy()
	})

	it('stops with the install record untouched when it cannot be read', async () => {
		await addTeam()
		mkdirSync(dirname(installedPluginsPath(home)), { recursive: true })
		writeFileSync(installedPluginsPath(home), '{ broken')
		const result = await plugin('install', ['ledger@team-tools', '--yes'])
		expect(result.code).toBe(66)
		expect(result.err).toContain('The install record could not be read, so nothing was changed')
		expect(readFileSync(installedPluginsPath(home), 'utf8')).toBe('{ broken')
		expect(existsSync(pluginCacheFolder(home))).toBe(false)
	})
})

describe('crash windows: a crash leaves an orphan, never a dangling record', () => {
	const steps: InstallStep[] = [
		'before-move',
		'after-move',
		'after-manifest',
		'after-record',
		'after-enabled',
	]

	for (const step of steps) {
		it(`a crash at ${step}`, async () => {
			await addTeam()
			const crashed = plugin('install', ['ledger@team-tools', '--yes'], {
				faults: (s) => {
					if (s === step) throw new SimulatedCrash(`died at ${s}`)
				},
			})
			await expect(crashed).rejects.toThrow(`died at ${step}`)
			const folder = join(pluginCacheFolder(home), 'team-tools', 'ledger', '1.0.0')
			const hasRecord =
				existsSync(installedPluginsPath(home)) && installed()['ledger@team-tools'] !== undefined
			// A record exists only from after-record on, and then the folder is there.
			expect(hasRecord).toBe(step === 'after-record' || step === 'after-enabled')
			if (hasRecord) expect(existsSync(folder)).toBe(true)
			expect(existsSync(folder)).toBe(step !== 'before-move')
			// Prune removes what no record names, and keeps what one does.
			const pruned = await plugin('prune', ['--yes', '--json'])
			expect(pruned.code).toBe(0)
			expect(existsSync(folder)).toBe(hasRecord)
			expect(
				existsSync(join(home, 'plugins', '.install-manifests', 'ledger@team-tools.json')),
			).toBe(hasRecord)
			// And the install can be done again from either state.
			const again = await plugin('install', ['ledger@team-tools', '--yes', '--json'])
			expect(again.code).toBe(0)
			expect(installed()['ledger@team-tools']).toHaveLength(1)
			expect((await records('list', ['--json'])).json().plugins[0]).toMatchObject({
				id: 'ledger@team-tools',
				state: 'on',
			})
		})
	}

	it('replaces an orphan folder a crash left, without prune', async () => {
		await addTeam()
		await expect(
			plugin('install', ['ledger@team-tools', '--yes'], {
				faults: (s) => {
					if (s === 'after-move') throw new SimulatedCrash('died')
				},
			}),
		).rejects.toThrow('died')
		const again = await plugin('install', ['ledger@team-tools', '--yes'])
		expect(again.code).toBe(0)
		expect((await records('list', ['--json'])).json().plugins[0].state).toBe('on')
	})

	for (const step of ['after-move', 'after-manifest'] as const) {
		it(`an error at ${step} that is not a crash puts things back`, async () => {
			await addTeam()
			const result = await plugin('install', ['ledger@team-tools', '--yes'], {
				faults: (s) => {
					if (s === step) throw new Error('disk full')
				},
			})
			expect(result.code).toBe(1)
			expect(result.err).toContain('disk full')
			expect(existsSync(join(pluginCacheFolder(home), 'team-tools', 'ledger', '1.0.0'))).toBe(false)
			expect(
				existsSync(join(home, 'plugins', '.install-manifests', 'ledger@team-tools.json')),
			).toBe(false)
			expect(existsSync(installedPluginsPath(home))).toBe(false)
		})
	}
})

describe('namzu plugin uninstall', () => {
	it('removes the record, the recorded yes, the manifest and the copy, and keeps the data', async () => {
		await addTeam()
		await plugin('install', ['ledger@team-tools', '--yes'])
		const data = join(home, 'plugins', 'data', 'ledger@team-tools')
		mkdirSync(data, { recursive: true })
		writeFileSync(join(data, 'db'), 'rows')
		const result = await plugin('uninstall', ['ledger@team-tools', '--json'])
		expect(result.code).toBe(0)
		expect(result.json()).toMatchObject({
			outcome: 'uninstalled',
			id: 'ledger@team-tools',
			scope: 'user',
			dataKept: true,
			dataDeleted: false,
			remaining: 0,
		})
		expect(installed()).toEqual({})
		expect(userSettings().enabledPlugins).toEqual({})
		expect(existsSync(join(home, 'plugins', '.install-manifests', 'ledger@team-tools.json'))).toBe(
			false,
		)
		expect(existsSync(join(pluginCacheFolder(home), 'team-tools', 'ledger'))).toBe(false)
		expect(readFileSync(join(data, 'db'), 'utf8')).toBe('rows')
		expect(readJson(join(data, '.origin.json'))).toMatchObject({ id: 'ledger@team-tools' })
	})

	it('warns when data kept from another source meets a new install, and needs --yes for it', async () => {
		const first = makePlugin(join(root, 'one/mine'), 'mine')
		await plugin('install', [first, '--yes'])
		const data = join(home, 'plugins', 'data', 'mine@local-uploads')
		mkdirSync(data, { recursive: true })
		writeFileSync(join(data, 'db'), 'rows')
		await plugin('uninstall', ['mine@local-uploads'])
		const second = makePlugin(join(root, 'two/mine'), 'mine')
		const digest = (await plugin('install', [second, '--dry-run', '--json'])).json().surfaceSha256
		const refused = await plugin('install', [second, '--accept-surface', digest, '--json'])
		expect(refused.code).toBe(75)
		expect(refused.json().message).toContain('came from another source')
		const asked = await plugin('install', [second], { interactive: true, answers: [true] })
		expect(asked.out).toContain('came from another source')
		expect(asked.code).toBe(0)
		expect(readFileSync(join(data, 'db'), 'utf8')).toBe('rows')
	})

	it('--delete-data deletes the data too', async () => {
		await addTeam()
		await plugin('install', ['ledger@team-tools', '--yes'])
		const data = join(home, 'plugins', 'data', 'ledger@team-tools')
		mkdirSync(data, { recursive: true })
		writeFileSync(join(data, 'db'), 'rows')
		const result = await plugin('uninstall', ['ledger@team-tools', '--delete-data', '--json'])
		expect(result.json().dataDeleted).toBe(true)
		expect(existsSync(data)).toBe(false)
	})

	it('keeps the shared copy while another scope uses it, and asks which scope when several apply', async () => {
		await addTeam()
		await plugin('install', ['ledger@team-tools', '--yes'])
		await plugin('install', ['ledger@team-tools', '--scope', 'local', '--yes'])
		const ambiguous = await plugin('uninstall', ['ledger@team-tools'])
		expect(ambiguous.code).toBe(64)
		const folder = join(pluginCacheFolder(home), 'team-tools', 'ledger', '1.0.0')
		const local = await plugin('uninstall', ['ledger@team-tools', '--scope', 'local', '--json'])
		expect(local.json().remaining).toBe(1)
		expect(existsSync(folder)).toBe(true)
		expect(existsSync(join(home, 'plugins', '.install-manifests', 'ledger@team-tools.json'))).toBe(
			true,
		)
		expect(readJson(recordLayerPath('local', { home, cwd })).enabledPlugins).toEqual({})
		await plugin('uninstall', ['ledger@team-tools'])
		expect(existsSync(folder)).toBe(false)
	})

	it('says a folder placed by hand is the person’s to remove, and exits 66 for what is not installed', async () => {
		write(join(home, 'plugins', 'hand'), {
			'plugin.json': { name: 'handy', version: '1.0.0', description: 'by hand', skills: [] },
		})
		const hand = await plugin('uninstall', ['handy'])
		expect(hand.code).toBe(64)
		expect(hand.err).toContain('Remove the folder yourself')
		expect((await plugin('uninstall', ['ghost@m'])).code).toBe(66)
		expect((await plugin('uninstall', [])).code).toBe(64)
	})

	it('edits the shared file of a project plugin only after a yes, and can turn it off for the person alone', async () => {
		await addTeam()
		await plugin('install', ['ledger@team-tools', '--scope', 'project', '--yes'])
		const refused = await plugin('uninstall', ['ledger@team-tools'])
		expect(refused.code).toBe(75)
		expect(refused.err).toContain('namzu plugin disable ledger@team-tools')
		expect(installed()['ledger@team-tools']).toBeDefined()
		const mine = await plugin('uninstall', ['ledger@team-tools'], {
			interactive: true,
			answers: [false, true],
		})
		expect(mine.code).toBe(0)
		expect(mine.out).toContain('Turned off ledger@team-tools for you only')
		expect(readJson(recordLayerPath('local', { home, cwd })).enabledPlugins).toEqual({
			'ledger@team-tools': false,
		})
		expect(installed()['ledger@team-tools']).toBeDefined()
		const all = await plugin('uninstall', ['ledger@team-tools'], {
			interactive: true,
			answers: [true],
		})
		expect(all.code).toBe(0)
		expect(installed()).toEqual({})
		expect(readJson(recordLayerPath('project', { home, cwd })).enabledPlugins).toEqual({})
	})

	it('exits 77 for a project install in a folder that is not trusted', async () => {
		await addTeam()
		await plugin('install', ['ledger@team-tools', '--scope', 'project', '--yes'])
		const result = await plugin('uninstall', ['ledger@team-tools', '--yes'], { trusted: false })
		expect(result.code).toBe(77)
		expect(installed()['ledger@team-tools']).toBeDefined()
	})
})

describe('namzu plugin prune', () => {
	const day = 24 * 60 * 60 * 1000
	it('removes copies no record names, honours the day an older version is kept, and lists with --dry-run', async () => {
		await addTeam()
		await plugin('install', ['ledger@team-tools', '--yes'])
		const stale = join(pluginCacheFolder(home), 'team-tools', 'ledger', '0.9.0')
		write(stale, { 'plugin.json': {} })
		writeFileSync(join(stale, '.orphaned_at'), `${now.toISOString()}\n`)
		const fresh = join(pluginCacheFolder(home), 'team-tools', 'ledger', '0.8.0')
		write(fresh, { x: 'y' })
		const orphanManifest = join(home, 'plugins', '.install-manifests', 'gone@team-tools.json')
		write(join(home, 'plugins', '.install-manifests'), { 'gone@team-tools.json': {} })
		const leftover = join(home, 'plugins', '.staging', 'abc')
		write(leftover, { x: 'y' })
		utimesSync(
			leftover,
			new Date(now.getTime() - 2 * 3600_000),
			new Date(now.getTime() - 2 * 3600_000),
		)
		const dry = await plugin('prune', ['--dry-run', '--json'])
		expect(dry.code).toBe(0)
		expect(
			dry
				.json()
				.items.map((i: { path: string }) => i.path)
				.sort(),
		).toEqual([fresh, leftover, orphanManifest].sort())
		expect(dry.json().kept.map((k: { path: string }) => k.path)).toEqual([stale])
		expect(existsSync(fresh)).toBe(true)
		const refused = await plugin('prune', [])
		expect(refused.code).toBe(75)
		expect(existsSync(fresh)).toBe(true)
		const done = await plugin('prune', ['--yes', '--json'])
		expect(done.json().outcome).toBe('pruned')
		expect(existsSync(fresh)).toBe(false)
		expect(existsSync(orphanManifest)).toBe(false)
		expect(existsSync(leftover)).toBe(false)
		expect(existsSync(stale)).toBe(true)
		now = new Date(now.getTime() + day + 1000)
		await plugin('prune', ['--yes'])
		expect(existsSync(stale)).toBe(false)
		expect(existsSync(join(pluginCacheFolder(home), 'team-tools', 'ledger', '1.0.0'))).toBe(true)
		expect((await plugin('prune', ['--json'])).json().outcome).toBe('nothing-to-do')
	})

	it('asks in a terminal', async () => {
		await addTeam()
		const orphan = join(pluginCacheFolder(home), 'team-tools', 'ledger', '0.1.0')
		write(orphan, { x: 'y' })
		expect((await plugin('prune', [], { interactive: true, answers: [false] })).code).toBe(1)
		expect(existsSync(orphan)).toBe(true)
		expect((await plugin('prune', [], { interactive: true, answers: [true] })).code).toBe(0)
		expect(existsSync(orphan)).toBe(false)
	})
})

describe('namzu plugin update', () => {
	it('applies a version the author raised after showing what changed, and keeps the old copy marked', async () => {
		const dir = await addTeam()
		await plugin('install', ['ledger@team-tools', '--yes'])
		const old = join(pluginCacheFolder(home), 'team-tools', 'ledger', '1.0.0')
		write(join(dir, 'plugins/ledger'), {
			[MANIFEST]: {
				name: 'ledger',
				version: '1.1.0',
				description: 'x',
				mcpServers: { extra: { command: 'python3', args: ['x.py'] } },
			},
			'x.py': 'print(1)\n',
		})
		const needs = await plugin('update', ['ledger@team-tools'])
		expect(needs.code).toBe(75)
		expect(needs.out).toContain('Update ledger@team-tools from 1.0.0 to 1.1.0?')
		expect(needs.out).toContain('What changed since the version you have:')
		expect(needs.out).toMatch(/server\s+extra\s+->\s+python3 x\.py/)
		expect(installed()['ledger@team-tools'][0].version).toBe('1.0.0')
		const accepted = await plugin('update', ['ledger@team-tools', '--yes', '--json'])
		expect(accepted.code).toBe(0)
		expect(accepted.json()).toMatchObject({ outcome: 'updated', from: '1.0.0', to: '1.1.0' })
		const fresh = join(pluginCacheFolder(home), 'team-tools', 'ledger', '1.1.0')
		expect(installed()['ledger@team-tools']).toEqual([
			expect.objectContaining({ version: '1.1.0', installPath: fresh }),
		])
		expect(existsSync(join(old, '.orphaned_at'))).toBe(true)
		expect(existsSync(join(old, 'server.js'))).toBe(true)
		expect(userSettings().enabledPlugins).toEqual({ 'ledger@team-tools': true })
		expect((await records('list', ['--json'])).json().plugins[0]).toMatchObject({
			version: '1.1.0',
			state: 'on',
		})
		expect((await plugin('update', ['ledger@team-tools', '--json'])).json().outcome).toBe(
			'up-to-date',
		)
		now = new Date(now.getTime() + 25 * 3600_000)
		await plugin('prune', ['--yes'])
		expect(existsSync(old)).toBe(false)
		expect(existsSync(fresh)).toBe(true)
	})

	it('declining leaves the installed version alone, and --accept-surface needs the new digest', async () => {
		const dir = await addTeam()
		await plugin('install', ['ledger@team-tools', '--yes'])
		write(join(dir, 'plugins/ledger'), {
			[MANIFEST]: { name: 'ledger', version: '2.0.0', description: 'x' },
		})
		const no = await plugin('update', ['ledger@team-tools'], {
			interactive: true,
			answers: [false],
		})
		expect(no.code).toBe(1)
		expect(installed()['ledger@team-tools'][0].version).toBe('1.0.0')
		const stale = await plugin('update', ['ledger@team-tools', '--accept-surface', 'a'.repeat(64)])
		expect(stale.code).toBe(75)
		const digest = (await plugin('update', ['ledger@team-tools', '--dry-run', '--json'])).json()
			.surfaceSha256
		expect((await plugin('update', ['ledger@team-tools', '--accept-surface', digest])).code).toBe(0)
		expect(installed()['ledger@team-tools'][0].version).toBe('2.0.0')
	})

	it('applies without asking when only a version the catalog names changed and what runs did not', async () => {
		const dir = join(root, 'pinned-market')
		write(join(dir, 'plugins/quiet'), {
			'skills/q/SKILL.md': skill('q'),
			[MANIFEST]: { name: 'quiet', description: 'Quiet.' },
		})
		makeMarketplace(dir, 'pinned-market', [
			{ name: 'quiet', source: './plugins/quiet', extra: { version: '1.0.0' } },
		])
		await market(['add', dir])
		await plugin('install', ['quiet@pinned-market', '--yes'])
		makeMarketplace(dir, 'pinned-market', [
			{ name: 'quiet', source: './plugins/quiet', extra: { version: '1.2.0' } },
		])
		const result = await plugin('update', ['quiet@pinned-market', '--json'])
		expect(result.code).toBe(0)
		expect(result.json()).toMatchObject({ outcome: 'updated', from: '1.0.0', to: '1.2.0' })
		expect(result.asked).toEqual([])
	})

	it('refuses a version that kept its number but changed', async () => {
		const dir = await addTeam()
		await plugin('install', ['ledger@team-tools', '--yes'])
		write(join(dir, 'plugins/ledger'), { 'server.js': '// changed\n' })
		const result = await plugin('update', ['ledger@team-tools', '--yes'])
		expect(result.code).toBe(65)
		expect(result.err).toContain('still says version 1.0.0 but its files changed')
	})

	it('updates an upload from the folder it came from', async () => {
		const upload = makePlugin(join(root, 'up/mine'), 'mine')
		await plugin('install', [upload, '--yes'])
		write(upload, {
			[MANIFEST]: { name: 'mine', version: '2.0.0', description: 'The mine plugin.' },
		})
		const result = await plugin('update', ['mine@local-uploads', '--yes', '--json'])
		expect(result.json()).toMatchObject({ outcome: 'updated', to: '2.0.0' })
		expect(existsSync(join(upload))).toBe(true)
	})

	it('exits 66 for what is not installed, and an upload whose folder is gone', async () => {
		expect((await plugin('update', ['ghost@m'])).code).toBe(66)
		const upload = makePlugin(join(root, 'up/mine'), 'mine')
		await plugin('install', [upload, '--yes'])
		removeTempDir(upload)
		expect((await plugin('update', ['mine@local-uploads', '--yes'])).code).toBe(66)
	})

	it('a crash during an update leaves the installed version working', async () => {
		const dir = await addTeam()
		await plugin('install', ['ledger@team-tools', '--yes'])
		write(join(dir, 'plugins/ledger'), {
			[MANIFEST]: { name: 'ledger', version: '3.0.0', description: 'x' },
		})
		for (const step of ['after-move', 'after-manifest'] as const) {
			await expect(
				plugin('update', ['ledger@team-tools', '--yes'], {
					faults: (s) => {
						if (s === step) throw new SimulatedCrash(`died at ${s}`)
					},
				}),
			).rejects.toThrow()
		}
		expect(installed()['ledger@team-tools'][0].version).toBe('1.0.0')
	})
})

describe('concurrent writers', () => {
	it('a second process installing into the same home loses none of the records', async () => {
		const mine: string[] = []
		const theirs: string[] = []
		for (let i = 0; i < 6; i++) {
			mine.push(makePlugin(join(root, `src/mine-${i}`), `mine-${i}`))
			theirs.push(makePlugin(join(root, `src/theirs-${i}`), `theirs-${i}`))
		}
		const child = promisify(execFile)(
			process.execPath,
			[
				'--import',
				'tsx',
				join(here, '..', '__fixtures__', 'install-child.ts'),
				home,
				cwd,
				...theirs,
			],
			{
				cwd: join(here, '..', '..'),
				env: { PATH: process.env.PATH ?? '', HOME: home, NAMZU_HOME: home },
			},
		)
		for (const folder of mine) expect((await plugin('install', [folder, '--yes'])).code).toBe(0)
		await child
		const ids = Object.keys(installed()).sort()
		expect(ids).toHaveLength(12)
		const yeses = Object.keys(userSettings().enabledPlugins).sort()
		expect(yeses).toEqual(ids)
	}, 60_000)

	it('two installs one after another in one tree keep both records and both recorded yeses', async () => {
		await addTeam()
		const [a, b] = await Promise.all([
			plugin('install', ['ledger@team-tools', '--yes']),
			plugin('install', ['notes@team-tools', '--yes']),
		])
		expect([a.code, b.code]).toEqual([0, 0])
		expect(Object.keys(installed()).sort()).toEqual(['ledger@team-tools', 'notes@team-tools'])
		expect(userSettings().enabledPlugins).toEqual({
			'ledger@team-tools': true,
			'notes@team-tools': true,
		})
	})
})

describe('review fixes: what is hashed, shown and removed', () => {
	const NAMZU_MANIFEST = 'plugin.json'

	it('hashes a TypeScript hook module and any other file, so a later edit fails the load check', async () => {
		const dir = join(root, 'tsmod')
		write(dir, {
			[NAMZU_MANIFEST]: {
				name: 'tsmod',
				version: '1.0.0',
				description: 'Has a module.',
				hooks: ['lib/h.ts'],
			},
			'lib/h.ts': 'export default () => ({})\n',
			'data/notes.txt': 'plain\n',
		})
		const result = await plugin('install', [dir, '--yes', '--json'])
		expect(result.code).toBe(0)
		expect(result.json().surface.modules).toEqual([{ path: 'lib/h.ts' }])
		const id = result.json().id as string
		const manifest = readJson(join(home, 'plugins', '.install-manifests', `${id}.json`))
		expect(manifest.executable).toEqual(expect.arrayContaining(['lib/h.ts', 'data/notes.txt']))
		const record = installed()[id]?.[0]
		writeFileSync(join(record.installPath, 'lib/h.ts'), 'export default () => ({ edited: 1 })\n')
		const { verifyInstalledCopy } = await import('../integrations/plugins/install-manifest.js')
		const verdict = verifyInstalledCopy(home, id, record.installPath, manifest.surfaceSha256)
		expect(verdict.ok).toBe(false)
	})

	it('splits allowed-tools on commas outside parentheses', async () => {
		const dir = join(root, 'tools')
		write(dir, {
			[MANIFEST]: { name: 'tools', version: '1.0.0', description: 'Tools.' },
			'skills/s/SKILL.md': skill('s', 'allowed-tools: Bash(git log:*), Read\n'),
		})
		const result = await plugin('install', [dir, '--dry-run', '--json'])
		expect(result.json().surface.allowedTools).toEqual([
			{ kind: 'skill', name: 's', tools: ['Bash(git log:*)', 'Read'] },
		])
		const text = await plugin('install', [dir, '--dry-run'])
		expect(text.out).toContain('allows Bash(git log:*), Read')
	})

	it('lists a remote server that needs a variable, with the variables, and does not call it unused', async () => {
		const dir = join(root, 'remote')
		write(dir, {
			[MANIFEST]: { name: 'remote', version: '1.0.0', description: 'Remote.' },
			'.mcp.json': {
				mcpServers: {
					rem: { type: 'http', url: 'https://mcp.example.com/' },
					rem2: {
						type: 'http',
						url: 'https://mcp.example.com/${NAMZU_TEST_TOK_UNSET}',
						headers: { Authorization: 'Bearer ${NAMZU_TEST_TOK2_UNSET}' },
					},
				},
			},
			'skills/s/SKILL.md': skill('s'),
		})
		const text = await plugin('install', [dir, '--dry-run'])
		expect(text.out).toMatch(/server\s+rem2\s+->\s+https:\/\/mcp\.example\.com/)
		expect(text.out).toContain('$NAMZU_TEST_TOK_UNSET')
		expect(text.out).toContain('$NAMZU_TEST_TOK2_UNSET')
		expect(text.out).toContain('needs setup')
		expect(text.out).not.toContain('Not used by Namzu')
	})

	it('does not delete a folder outside the plugin cache when uninstalling a tampered record', async () => {
		const victim = join(root, 'victim')
		write(victim, { 'precious.txt': 'keep' })
		const { putInstallRecord } = await import('../integrations/plugins/records.js')
		const { removeInstall } = await import('../integrations/plugins/install.js')
		putInstallRecord(home, 'a@mk', { scope: 'user', installPath: victim, version: '1.0.0' })
		const out = removeInstall('a@mk', { scope: 'user' }, { home, now, deleteData: false })
		expect(out.removedRecord).toBe(true)
		expect(out.folderRemoved).toBe(false)
		expect(existsSync(join(victim, 'precious.txt'))).toBe(true)
	})

	it('declares an already-added marketplace at a second scope', async () => {
		const dir = await addTeam()
		const result = await market(['add', dir, '--scope', 'project', '--json'])
		expect(result.code).toBe(0)
		expect(result.json().outcome).toBe('added')
		expect(
			readJson(recordLayerPath('project', { home, cwd })).extraKnownMarketplaces['team-tools'],
		).toBeDefined()
		const again = await market(['add', dir, '--scope', 'project', '--json'])
		expect(again.json().outcome).toBe('already-added')
	})

	it('updates without asking when only the version changed and nothing runs', async () => {
		const dir = join(root, 'cmd-market')
		write(join(dir, 'plugins/only-cmd'), {
			[MANIFEST]: { name: 'only-cmd', version: '0.1.0', description: 'A command.' },
			'commands/hi.md': 'Say hi.',
		})
		makeMarketplace(dir, 'cmd-market', [{ name: 'only-cmd', source: './plugins/only-cmd' }])
		await market(['add', dir])
		await plugin('install', ['only-cmd@cmd-market', '--yes'])
		write(join(dir, 'plugins/only-cmd'), {
			[MANIFEST]: { name: 'only-cmd', version: '0.2.0', description: 'A command.' },
		})
		const result = await plugin('update', ['only-cmd@cmd-market', '--json'])
		expect(result.code).toBe(0)
		expect(result.json()).toMatchObject({ outcome: 'updated', from: '0.1.0', to: '0.2.0' })
	})

	it('prints the preview on standard error with --yes', async () => {
		const dir = await addTeam()
		void dir
		const result = await plugin('install', ['ledger@team-tools', '--yes'])
		expect(result.code).toBe(0)
		expect(result.err).toContain('Runs on this computer')
		expect(result.err).toContain('Surface: sha256:')
	})
})
