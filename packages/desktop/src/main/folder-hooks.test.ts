import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type HooksReport, readHooksReport } from '../shared/hooks-report.js'
import type { ProjectView } from '../shared/protocol.js'
import { FolderAccess } from './folder-access.js'
import {
	createFolderHooksReader,
	findingsFromReport,
	inspectFolderWithHooks,
	parseHooksOutput,
	startsInFolder,
} from './folder-hooks.js'

const folders: string[] = []
afterEach(() => {
	vi.useRealTimers()
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})
function folder(files: Record<string, string> = {}): string {
	const root = mkdtempSync(join(tmpdir(), 'namzu-folder-hooks-'))
	folders.push(root)
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(join(root, name, '..'), { recursive: true })
		writeFileSync(join(root, name), text)
	}
	return root
}

const row = (over: Record<string, unknown>) => ({
	id: 'x',
	event: 'pre_tool_use',
	type: 'command',
	runs: 'guard.sh',
	state: 'not-loaded',
	why: {
		code: 'folder-not-trusted',
		text: 'This folder is not trusted. It starts once the folder is trusted.',
	},
	origin: { kind: 'config', label: '/work/app/namzu.config.json', scope: 'project' },
	...over,
})
const report = (hooks: unknown[], problems: unknown[] = [], trusted = false): HooksReport =>
	readHooksReport({
		version: 1,
		folder: { path: '/work/app', trusted },
		switches: {
			disableHooks: { on: false },
			hooksManagedOnly: { on: false },
			plugins: { on: true },
		},
		hooks,
		modules: [],
		problems,
		counts: {},
	}) as HooksReport

describe('what would start by itself in a folder, from the engine’s answer', () => {
	it('names the hooks of project files, plugins, skills and agent files, each with its source', () => {
		const found = findingsFromReport(
			report([
				row({ id: '1' }),
				row({ id: '2', event: 'post_tool_use', runs: 'fmt.sh' }),
				row({
					id: '3',
					runs: 'review.sh',
					origin: {
						kind: 'plugin',
						label: 'plugin review-bot',
						name: 'review-bot',
						scope: 'project',
					},
				}),
				row({
					id: '4',
					runs: 'node careful.mjs',
					origin: { kind: 'skill', label: 'skill careful', name: 'careful', scope: 'project' },
				}),
				row({
					id: '5',
					runs: 'node guard.mjs',
					origin: { kind: 'agent', label: 'agent runner', name: 'runner', scope: 'project' },
				}),
				// Your own hooks start no matter which folder is trusted: not part of this folder's ask.
				row({
					id: '6',
					state: 'runs',
					why: undefined,
					origin: { kind: 'config', label: '~/.namzu/config.yaml', scope: 'user' },
				}),
			]),
			'/work/app',
		)
		expect(found.map((item) => item.label)).toEqual([
			'2 hooks from /work/app/namzu.config.json',
			'1 hook from the plugin review-bot',
			'1 hook from the skill careful (when it is used)',
			'1 hook from the agent file runner (when it runs)',
		])
		expect(found[0]?.lines).toEqual(['pre tool use: guard.sh', 'post tool use: fmt.sh'])
		expect(found.flatMap((item) => item.lines).join('\n')).not.toContain('~/.namzu/config.yaml')
	})

	it('counts a row in when sources disagree about whether it belongs to the folder', () => {
		const inFolder = (over: Record<string, unknown>) =>
			startsInFolder(report([row(over)]).hooks[0] as never, '/work/app')
		// Held back by trust, whatever its scope says.
		expect(inFolder({ origin: { kind: 'config', label: 'x', scope: 'user' } })).toBe(true)
		// Trusted already, but a project file.
		expect(inFolder({ state: 'runs', why: undefined })).toBe(true)
		// A source that lives under the folder, whatever its scope says.
		expect(
			inFolder({
				state: 'runs',
				why: undefined,
				origin: {
					kind: 'skill',
					label: 'skill s',
					path: '/work/app/.namzu/skills/s',
					scope: 'user',
				},
			}),
		).toBe(true)
		expect(
			inFolder({
				state: 'runs',
				why: undefined,
				origin: {
					kind: 'skill',
					label: 'skill s',
					path: '/work/app-other/skills/s',
					scope: 'user',
				},
			}),
		).toBe(false)
	})

	it('shows a hook that is off with the engine’s reason, so a person sees what a switch is holding back', () => {
		const [item] = findingsFromReport(
			report([
				row({
					state: 'off',
					why: {
						code: 'disableHooks',
						text: 'disableHooks is on: hooks that are not from the managed file are off.',
					},
				}),
			]),
			'/work/app',
		)
		expect(item?.lines[0]).toContain('off now: disableHooks is on')
	})

	it('says when a hook in the folder could not be loaded, so a lost guard is not a quiet folder', () => {
		const found = findingsFromReport(
			report(
				[],
				[
					{
						severity: 'problem',
						origin: { kind: 'skill', label: 'skill careful', name: 'careful', scope: 'project' },
						message: 'The skill loads without its hooks.',
						inactive: 'folder-not-trusted',
					},
					{
						severity: 'note',
						origin: { kind: 'config', label: 'x', scope: 'project' },
						message: 'minor',
					},
				],
			),
			'/work/app',
		)
		expect(found).toHaveLength(1)
		expect(found[0]?.label).toBe('1 hook entry in this folder that could not be loaded')
		expect(found[0]?.lines).toEqual(['skill careful: The skill loads without its hooks.'])
	})

	it('still warns when the folder\u2019s configuration cannot be read at all', () => {
		const unreadable = {
			...report(
				[],
				[
					{
						severity: 'problem',
						origin: { kind: 'config', label: 'configuration' },
						message: 'The configuration could not be read: hooks.turn_end must be an array',
					},
				],
			),
			error: 'hooks.turn_end must be an array',
		}
		const found = findingsFromReport(unreadable, '/work/app')
		expect(found).toHaveLength(1)
		expect(found[0]?.lines[0]).toContain('The configuration could not be read')
		// A problem of that name with no error in the answer is not taken for it.
		expect(findingsFromReport({ ...unreadable, error: undefined }, '/work/app')).toEqual([])
	})

	it('never puts a header or an env value into the dialog', () => {
		const found = findingsFromReport(
			report([
				row({
					type: 'http',
					runs: 'POST https://u:pw@h.example/p?k=SECRETQ',
					headers: { Authorization: 'Bearer SECRETH' },
					env: { TOKEN: 'SECRETE' },
				}),
			]),
			'/work/app',
		)
		expect(JSON.stringify(found)).not.toMatch(/SECRET|pw@/)
		expect(found[0]?.lines[0]).toBe('pre tool use: POST https://h.example/p')
	})
})

describe('the folder’s own list, with and without the engine’s answer', () => {
	const config = JSON.stringify({
		hooks: { pre_tool_use: [{ command: 'guard.sh' }] },
		mcpServers: { files: { command: 'npx', args: ['files-server'] } },
	})

	it('replaces the dialog’s own line about hooks with the engine’s, and keeps its other lines', async () => {
		const root = folder({ 'namzu.config.json': config })
		const { found, incomplete } = await inspectFolderWithHooks(root, async () =>
			report([
				row({ id: 'e1', runs: 'guard.sh' }),
				row({ id: 'e2', origin: { kind: 'skill', label: 'skill s', name: 's', scope: 'project' } }),
			]),
		)
		expect(incomplete).toBeUndefined()
		const labels = found.map((item) => item.label)
		expect(labels).toContain('1 tool it can start (an MCP server)')
		expect(labels.some((label) => label.startsWith('1 hook from /work/app'))).toBe(true)
		expect(labels).toContain('1 hook from the skill s (when it is used)')
		expect(labels).not.toContain('commands that run by themselves at set moments (hooks)')
	})

	it('falls back to its own parser and says the list may be incomplete when the engine cannot answer', async () => {
		const root = folder({ 'namzu.config.json': config })
		for (const read of [async () => undefined, async () => Promise.reject(new Error('gone'))]) {
			const { found, incomplete } = await inspectFolderWithHooks(root, read)
			expect(incomplete).toBe(true)
			expect(found.map((item) => item.label)).toContain(
				'commands that run by themselves at set moments (hooks)',
			)
		}
	})

	it('reaches the trust dialog as riskySettings, with the incomplete mark only when it applies', async () => {
		const root = folder({ 'namzu.config.json': config })
		const view = (path: string): ProjectView => ({
			id: 'p1',
			path,
			name: 'app',
			trusted: false,
			status: 'ready',
		})
		const make = (read: Parameters<typeof inspectFolderWithHooks>[1]) =>
			new FolderAccess({
				openProject: async (path) => view(path),
				findProject: () => undefined,
				trust: async () => ({ ...view(root), trusted: true }),
				inspectFolder: (path) => inspectFolderWithHooks(path, read),
				env: { platform: 'linux', home: '/nowhere', env: {} },
			})
		const answered = await make(async () => report([row({})])).picked('w1', root)
		expect(answered.pending).toBe(true)
		expect(answered.riskySettings?.found.join('\n')).toContain('from /work/app/namzu.config.json')
		expect(answered.riskySettings).not.toHaveProperty('incomplete')
		const fallback = await make(async () => undefined).picked('w1', root)
		expect(fallback.riskySettings?.incomplete).toBe(true)
		const quiet = folder({})
		const none = await make(async () => report([], [], true)).picked('w1', quiet)
		expect(none.riskySettings).toBeUndefined()
	})
})

describe('asking the engine as a short process', () => {
	function fakeSpawn() {
		const calls: { program: string; args: string[] }[] = []
		let child!: EventEmitter & {
			stdout: EventEmitter & { setEncoding: () => void }
			kill: ReturnType<typeof vi.fn>
		}
		const spawnProcess = ((program: string, args: string[]) => {
			calls.push({ program, args })
			const stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
			child = Object.assign(new EventEmitter(), { stdout, kill: vi.fn() })
			return child
		}) as never
		return {
			calls,
			spawnProcess,
			get child() {
				return child
			},
		}
	}
	const command = { program: 'node', prefix: ['cli.js'], env: {} }
	const sample = JSON.stringify({
		version: 1,
		folder: { path: '/w', trusted: false },
		hooks: [],
	})

	it('runs `hooks --cwd=<folder> --json` and reads its one JSON value', async () => {
		const fake = fakeSpawn()
		const read = createFolderHooksReader(command, { spawnProcess: fake.spawnProcess })
		const pending = read('/work/app')
		fake.child.stdout.emit('data', `warming up\n${sample}\n`)
		fake.child.emit('close', 0)
		expect((await pending)?.folder.path).toBe('/w')
		expect(fake.calls).toEqual([
			{ program: 'node', args: ['cli.js', 'hooks', '--cwd=/work/app', '--json'] },
		])
	})

	it('is nothing for an engine that does not know the command, or prints something else', async () => {
		for (const [code, text] of [
			[2, 'unknown command: hooks'],
			[0, 'not json'],
			[0, JSON.stringify({ version: 1 })],
		] as const) {
			const fake = fakeSpawn()
			const pending = createFolderHooksReader(command, { spawnProcess: fake.spawnProcess })('/w')
			fake.child.stdout.emit('data', text)
			fake.child.emit('close', code)
			expect(await pending).toBeUndefined()
		}
		const fake = fakeSpawn()
		const pending = createFolderHooksReader(command, { spawnProcess: fake.spawnProcess })('/w')
		fake.child.emit('error', new Error('ENOENT'))
		expect(await pending).toBeUndefined()
	})

	it('stops waiting on a wedged process, by the clock and not by a race', async () => {
		vi.useFakeTimers()
		const fake = fakeSpawn()
		const pending = createFolderHooksReader(command, {
			spawnProcess: fake.spawnProcess,
			timeoutMs: 1000,
		})('/w')
		await vi.advanceTimersByTimeAsync(1000)
		expect(await pending).toBeUndefined()
		expect(fake.child.kill).toHaveBeenCalled()
	})

	it('gives back the engine it borrowed, whatever happened', async () => {
		const release = vi.fn()
		const fake = fakeSpawn()
		const read = createFolderHooksReader(async () => ({ ...command, release }), {
			spawnProcess: fake.spawnProcess,
		})
		const pending = read('/w')
		await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
		fake.child.emit('close', 1)
		await pending
		expect(release).toHaveBeenCalledTimes(1)
		const refused = createFolderHooksReader(async () => Promise.reject(new Error('no engine')))
		expect(await refused('/w')).toBeUndefined()
	})

	it('parses the answer from the last line when something printed before it', () => {
		expect(parseHooksOutput(`noise\n${sample}`)?.version).toBe(1)
		expect(parseHooksOutput('')).toBeUndefined()
	})
})
