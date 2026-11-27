import { describe, expect, it } from 'vitest'
import type { PluginSurfaceView } from '../shared/customize-protocol.js'
import { OP_ID_PATTERN } from '../shared/customize-protocol.js'
import type { ComposerPlugin } from './composer-plugins.js'
import {
	LOCAL_UPLOADS,
	PLACED_NO_UPDATES,
	UPLOADS_NO_UPDATES,
	consentSections,
	groupPlugins,
	groupTitle,
	installedFrom,
	isManaged,
	marketplaceLetter,
	marketplaceSub,
	newOpId,
	noUpdateReason,
	previewLine,
	recordScope,
	removeMarketplaceBody,
	shortDigest,
	updateState,
	updateWords,
} from './customize-plugins-model.js'

const plugin = (over: Partial<ComposerPlugin> = {}): ComposerPlugin => ({
	name: 'ledger',
	version: '1.0.0',
	description: 'Books.',
	scope: 'user',
	status: 'enabled',
	...over,
})

const surface = (over: Partial<PluginSurfaceView> = {}): PluginSurfaceView => ({
	hooks: [],
	fileHooks: [],
	mcpLocal: [],
	mcpRemote: [],
	modules: [],
	allowedTools: [],
	scripts: [],
	scriptsTotal: 0,
	unpinnedDownload: false,
	...over,
})

describe('the address preview line', () => {
	it('says what would be added, or why not, in the words the engine used', () => {
		expect(previewLine({ source: '/tmp/market', kind: 'path', remote: false })).toEqual({
			tone: 'ok',
			text: 'Will add /tmp/market',
		})
		expect(previewLine({ error: 'Marketplaces must use https://.' })).toEqual({
			tone: 'error',
			text: 'Marketplaces must use https://.',
		})
		expect(
			previewLine({
				source: 'acme/tools',
				kind: 'github',
				remote: true,
				blocked: 'Needs a download.',
			}),
		).toEqual({ tone: 'error', text: 'Needs a download.' })
		expect(previewLine(undefined)).toBeUndefined()
		expect(previewLine(null)).toBeUndefined()
	})
})

describe('step ids', () => {
	it('are accepted by the engine pattern and differ between calls', () => {
		const a = newOpId('market')
		expect(a).toMatch(OP_ID_PATTERN)
		expect(newOpId('market')).not.toBe(a)
	})
})

describe('grouping the installed plugins', () => {
	it('puts plugins without a marketplace first, then one group per marketplace', () => {
		const groups = groupPlugins([
			plugin({ name: 'a', marketplace: 'team-tools' }),
			plugin({ name: 'b' }),
			plugin({ name: 'c', marketplace: LOCAL_UPLOADS }),
			plugin({ name: 'd', marketplace: 'team-tools' }),
		])
		expect(groups.map((g) => [g.title, g.plugins.map((p) => p.name)])).toEqual([
			['Installed', ['b']],
			['From team-tools', ['a', 'd']],
			['Uploaded', ['c']],
		])
		expect(groupTitle(undefined)).toBe('Installed')
	})
	it('lists the plugins one marketplace brought, for the removal notice', () => {
		const all = [plugin({ name: 'a', marketplace: 'm' }), plugin({ name: 'b' })]
		expect(installedFrom(all, 'm')).toEqual(['a'])
		expect(removeMarketplaceBody('m', ['a'])).toBe(
			'This also removes 1 plugin you installed from it. Their saved data is kept.',
		)
		expect(removeMarketplaceBody('m', ['a', 'b'])).toContain('2 plugins')
		expect(removeMarketplaceBody('m', [])).toContain('No plugin you installed came from it.')
	})
})

describe('which plugins Namzu can change', () => {
	it('manages only a plugin with an id and an install record, in the record that lists it', () => {
		const managed = plugin({ id: 'ledger@m', installed: ['project', 'user'], scope: 'user' })
		expect(isManaged(managed)).toBe(true)
		expect(recordScope(managed)).toBe('user')
		expect(recordScope(plugin({ id: 'x@m', installed: ['local'] }))).toBe('local')
		expect(isManaged(plugin())).toBe(false)
		expect(isManaged(plugin({ id: 'x@m' }))).toBe(false)
	})
	it('gives uploads and hand-placed plugins a reason instead of an update check', () => {
		expect(noUpdateReason(plugin())).toBe(PLACED_NO_UPDATES)
		expect(noUpdateReason(plugin({ id: 'x@local-uploads', marketplace: LOCAL_UPLOADS }))).toBe(
			UPLOADS_NO_UPDATES,
		)
		expect(noUpdateReason(plugin({ id: 'x@m', marketplace: 'm' }))).toBeUndefined()
	})
})

describe('what an update check says', () => {
	it('reads the answer as up to date or a version that is available', () => {
		const current = updateState({
			id: 'x@m',
			current: '1.0.0',
			latest: '1.0.0',
			upToDate: true,
			changesExecutable: false,
		})
		expect(updateWords(current)).toBe('Up to date')
		const next = updateState({
			id: 'x@m',
			current: '1.0.0',
			latest: '1.3.0',
			upToDate: false,
			changesExecutable: true,
		})
		expect(updateWords(next)).toBe('Version 1.3.0 is available')
		expect(updateWords({ kind: 'checking' })).toBe('Checking for updates')
		expect(updateWords({ kind: 'failed' })).toBe('Couldn’t check for updates. Try again.')
		expect(updateWords(undefined)).toBeUndefined()
	})
})

describe('the consent sections', () => {
	it('lists what it adds, what runs, and what Namzu ignores', () => {
		const sections = consentSections(
			surface({
				hooks: [{ event: 'PreToolUse', matcher: 'Bash', type: 'command', run: 'audit.sh' }],
				mcpLocal: [{ name: 'books', command: 'node', args: ['serve.js'], envNames: ['BOOKS_KEY'] }],
				mcpRemote: [
					{
						name: 'cloud',
						origin: 'https://mcp.example.com',
						transport: 'http',
						sendsEnv: ['CLOUD_TOKEN'],
						headers: ['Authorization'],
					},
				],
				scriptsTotal: 3,
				scripts: [{ path: 'a.sh', bytes: 4, exec: true }],
			}),
			{ skills: ['deploy'], commands: ['ship'], agents: [] },
			[
				{ level: 'ignored', code: 'sidecar-shipped', message: 'extra.json is not used.' },
				{ level: 'warning', code: 'x', message: 'Not shown here.' },
			],
		)
		expect(sections.map((s) => s.id)).toEqual(['adds', 'runs', 'ignored'])
		expect(sections[0]?.lines).toEqual(['Skills: deploy', 'Commands: ship'])
		const runs = sections[1]?.lines.join('\n') ?? ''
		expect(runs).toContain('Hook: Before a tool runs (Bash): audit.sh')
		expect(runs).toContain('Server books (environment: BOOKS_KEY): node serve.js')
		expect(runs).toContain(
			'Server cloud (asks you before it connects; would send $CLOUD_TOKEN; headers: Authorization): https://mcp.example.com',
		)
		expect(runs).toContain('Script (4 B, executable): a.sh')
		expect(runs).toContain('and 2 more scripts it ships')
		expect(sections[2]).toMatchObject({ muted: true, lines: ['extra.json is not used.'] })
	})
	it('shows what the command line shows: hook type, module isolation, needs setup, and what was left out', () => {
		const sections = consentSections(
			surface({
				hooks: [{ event: 'session_start', type: 'prompt', run: 'say hi' }],
				mcpLocal: [{ name: 'a', command: 'x', args: [], envNames: [], needsSetup: true }],
				modules: [
					{ path: 'm1.js', isolated: true, declares: ['network'] },
					{ path: 'm2.js' },
					{ path: 'm3.js', refused: 'no manifest' },
				],
			}),
			undefined,
			[{ level: 'refused', code: 'x', message: 'hooks.json entry 2 was left out.' }],
		)
		const runs = sections.find((s) => s.id === 'runs')?.lines.join('\n') ?? ''
		expect(runs).toContain('Prompt hook: When a conversation starts: say hi')
		expect(runs).toContain('needs setup: not started until its variables are set')
		expect(runs).toContain('Module (runs in an isolated worker; network): m1.js')
		expect(runs).toContain('Module (JavaScript that runs inside the session')
		expect(runs).toContain('Module (not run: no manifest): m3.js')
		expect(sections.find((s) => s.id === 'left')?.lines).toEqual([
			'hooks.json entry 2 was left out.',
		])
	})
	it('keeps a long command whole', () => {
		const long = `node ${'a'.repeat(1500)} --tail-end`
		const runs = consentSections(
			surface({ mcpLocal: [{ name: 'a', command: 'node', args: [long.slice(5)], envNames: [] }] }),
			undefined,
			[],
		)[0]
		expect(runs?.rows[0]?.code).toContain('--tail-end')
	})
	it('has no section for what a plugin does not do', () => {
		expect(consentSections(surface(), { skills: [], commands: [], agents: [] }, [])).toEqual([])
	})
	it('says when code is downloaded without a pinned version', () => {
		const sections = consentSections(surface({ unpinnedDownload: true }), undefined, [])
		expect(sections[0]?.lines[0]).toContain('not pinned')
	})
})

describe('small helpers', () => {
	it('draws a marketplace by its first letter and counts its plugins', () => {
		expect(marketplaceLetter('team-tools')).toBe('T')
		expect(marketplaceLetter('  ')).toBe('?')
		const row = {
			name: 'team-tools',
			source: '/work/market',
			kind: 'path',
			autoUpdate: false,
			plugins: 1,
			installed: 0,
		}
		expect(marketplaceSub(row, 'today')).toBe('1 plugin · /work/market · updated today')
		expect(marketplaceSub({ ...row, plugins: null }, '')).toBe('Not read yet · /work/market')
	})
	it('shortens a digest to its two ends', () => {
		expect(shortDigest('a'.repeat(8) + 'm'.repeat(48) + 'z'.repeat(8))).toBe('aaaaaaaa…zzzzzzzz')
	})
})
