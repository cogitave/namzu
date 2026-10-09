import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type {
	TerminalAttachResult,
	TerminalCreateSpec,
	TerminalInfo,
} from '../shared/terminal-protocol.js'
import {
	ACTIVITY_IDLE_MS,
	ACTIVITY_WORKING_MS,
	type TerminalTabView,
	terminalTabId,
} from '../shared/terminal-tabs.js'
import type { TerminalEvent, TerminalOpenRequest } from '../shared/terminal-view.js'
import {
	type HostTerminals,
	type HubConnection,
	type TerminalEndInfo,
	TerminalHub,
	type TerminalHubOptions,
	uniqueTabTitle,
} from './terminal-hub.js'
import type { SavedTerminalTab } from './terminal-tab-store.js'

/** Lets the promise chains the hub starts run to their end; no clock is involved. */
const settle = async () => {
	for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}

const HOST_A = '0f0e0d0c-0b0a-4908-8706-050403020100'
const HOST_B = '1f0e0d0c-0b0a-4908-8706-050403020101'
const TAB_A = terminalTabId(HOST_A)
const TAB_B = terminalTabId(HOST_B)

class FakeClient extends EventEmitter {
	created: TerminalCreateSpec[] = []
	calls: string[] = []
	available = true
	next: string[] = [HOST_A, HOST_B]
	offsets = new Map<string, number>()
	status = async () => ({
		available: this.available,
		...(this.available ? {} : { reason: 'node-pty is not installed' }),
		platform: 'linux',
		limits: { maxTerminals: 16, maxCols: 500, maxRows: 200, maxWrite: 65536, maxChunk: 16384 },
	})
	create = async (spec: TerminalCreateSpec): Promise<TerminalInfo> => {
		this.created.push(spec)
		const id = this.next.shift() ?? HOST_B
		return {
			id,
			pid: 5,
			title: spec.title ?? 'sh',
			cwd: spec.cwd ?? '/p',
			command: spec.command ?? 'sh',
			args: spec.args ?? [],
			cols: spec.cols,
			rows: spec.rows,
			status: 'running',
			createdAt: 100 + this.created.length,
			offset: 0,
			writerHeld: false,
		}
	}
	attach = async (
		id: string,
		viewer: string,
		options: { fromOffset?: number; writer?: boolean; force?: boolean } = {},
	): Promise<TerminalAttachResult> => {
		this.calls.push(
			`attach:${id}:${viewer}:${options.fromOffset ?? '-'}:${options.writer ? 'w' : 'r'}`,
		)
		return {
			terminal: {
				id,
				pid: 5,
				title: 't',
				cwd: '/p',
				command: 'sh',
				args: [],
				cols: 80,
				rows: 24,
				status: 'running',
				createdAt: 1,
				offset: 0,
				writerHeld: false,
			},
			mode: options.fromOffset === undefined ? 'snapshot' : 'replay',
			screen: options.fromOffset === undefined ? 'SCREEN' : '',
			data: options.fromOffset === undefined ? '' : 'replayed',
			start: options.fromOffset ?? 0,
			end: 10,
			writer: options.writer === true,
			truncated: false,
		}
	}
	detach = async (id: string, viewer: string) => {
		this.calls.push(`detach:${id}:${viewer}`)
	}
	write = async (id: string, viewer: string, data: string) => {
		this.calls.push(`write:${id}:${viewer}:${data}`)
	}
	resize = async (id: string, viewer: string, cols: number, rows: number) => {
		this.calls.push(`resize:${id}:${viewer}:${cols}x${rows}`)
	}
	close = async (id: string) => {
		this.calls.push(`close:${id}`)
	}
	nextOffset = (id: string) => this.offsets.get(id)
	disposed = false
	dispose = () => {
		this.disposed = true
	}
}

class FakeConnection extends EventEmitter implements HubConnection {
	terminals = true
	supportsTerminals = () => this.terminals
	request = async () => ({})
}

function setup(over: Partial<TerminalHubOptions> = {}) {
	const client = new FakeClient()
	const connection = new FakeConnection()
	const sent: { windowId: string; event: TerminalEvent }[] = []
	const published: TerminalTabView[][] = []
	const saves: SavedTerminalTab[][] = []
	let now = 1_000
	const repeaters = new Set<() => void>()
	const timers: { run: () => void; ms: number; live: boolean }[] = []
	const hub = new TerminalHub({
		projectHost: (projectId) => {
			if (projectId !== 'p1') throw new Error('Reopen this project to connect Namzu.')
			return { project: { id: 'p1', name: 'api', path: '/work/api' }, connection }
		},
		createClient: () => client as unknown as HostTerminals,
		settings: () => ({ terminalShell: 'auto', restoreTerminals: true }),
		shellEnvironment: () => ({
			platform: 'linux',
			env: { SHELL: '/bin/zsh' },
			find: () => undefined,
		}),
		engineHost: () => ({
			platform: 'linux',
			execPath: '/opt/namzu',
			cliEntry: '/opt/cli/bin.js',
			nodeArgs: [],
			resolve: (name) => ({ path: `/bin/${name}`, shim: false }),
		}),
		publish: (tabs) => published.push(tabs),
		send: (windowId, event) => sent.push({ windowId, event }),
		save: (tabs) => saves.push(tabs),
		clock: {
			now: () => now,
			every: (_ms, run) => {
				repeaters.add(run)
				return () => repeaters.delete(run)
			},
			after: (ms, run) => {
				const timer = { run, ms, live: true }
				timers.push(timer)
				return () => {
					timer.live = false
				}
			},
		},
		...over,
	})
	return {
		hub,
		client,
		connection,
		sent,
		published,
		saves,
		advance: (ms: number) => {
			now += ms
			for (const run of [...repeaters]) run()
		},
		fire: () => {
			for (const timer of timers.splice(0)) if (timer.live) timer.run()
		},
		repeaters,
	}
}

const shell: TerminalOpenRequest = {
	projectId: 'p1',
	groupId: 'g',
	cols: 100,
	rows: 30,
	kind: 'shell',
}
const engine: TerminalOpenRequest = {
	projectId: 'p1',
	groupId: 'g',
	cols: 100,
	rows: 30,
	kind: 'engine',
	engine: 'codex-cli',
	model: 'gpt-5',
	effort: 'high',
	permissionMode: 'plan',
}

describe('opening a terminal', () => {
	it('starts the login shell in the project folder and lists the tab', async () => {
		const t = setup()
		const { terminal } = await t.hub.open(shell)
		expect(t.client.created).toEqual([
			{ cwd: '/work/api', command: '/bin/zsh', args: [], cols: 100, rows: 30, title: 'zsh · api' },
		])
		expect(terminal).toMatchObject({
			id: TAB_A,
			projectId: 'p1',
			kind: 'shell',
			title: 'zsh · api',
			status: 'running',
		})
		expect(terminal.activity).toBeUndefined()
		// The hub watches every terminal itself, so output and an exit are seen with no window open.
		expect(t.client.calls).toContain(`attach:${HOST_A}:desktop:-:r`)
		expect(t.hub.list().map((tab) => tab.id)).toEqual([TAB_A])
		expect(t.published.at(-1)?.map((tab) => tab.id)).toEqual([TAB_A])
		expect(t.saves.at(-1)?.[0]?.view.id).toBe(TAB_A)
	})

	it('tells two shells of one project apart by number', async () => {
		const t = setup()
		const first = await t.hub.open(shell)
		const second = await t.hub.open(shell)
		expect([first.terminal.title, second.terminal.title]).toEqual(['zsh · api', 'zsh 2 · api'])
		expect(uniqueTabTitle('a', ['a', 'a 2'])).toBe('a 3')
		expect(uniqueTabTitle('Codex CLI · api', ['Codex CLI · api'])).toBe('Codex CLI 2 · api')
		expect(uniqueTabTitle('a', ['b'])).toBe('a')
	})

	it('starts an engine CLI with the composer choices and names the tab for engine and project', async () => {
		const t = setup()
		const { terminal, omitted } = await t.hub.open(engine)
		expect(t.client.created[0]).toMatchObject({
			command: '/bin/codex',
			args: ['-m', 'gpt-5', '-c', 'model_reasoning_effort=high', '-a', 'never', '-s', 'read-only'],
			title: 'Codex CLI · api',
		})
		expect(terminal).toMatchObject({ kind: 'engine', engine: 'codex-cli', activity: 'working' })
		expect(omitted).toEqual([])
	})

	it('refuses with the host reason, an unknown project, a missing program and a bad size', async () => {
		const t = setup()
		t.client.available = false
		await expect(t.hub.open(shell)).rejects.toThrow('node-pty is not installed')
		t.client.available = true
		await expect(t.hub.open({ ...shell, projectId: 'p2' })).rejects.toThrow(/Reopen this project/)
		await expect(t.hub.open({ ...shell, cols: 0 })).rejects.toThrow(/width/)
		await expect(t.hub.open({ ...shell, rows: 9999 })).rejects.toThrow(/height/)
		t.connection.terminals = false
		await expect(t.hub.open(shell)).rejects.toThrow(/no terminals/)
		t.connection.terminals = true
		const missing = setup({
			engineHost: () => ({
				platform: 'linux',
				execPath: '/x',
				nodeArgs: [],
				resolve: () => undefined,
			}),
		})
		await expect(missing.hub.open(engine)).rejects.toThrow(/Codex CLI is not installed/)
		expect(missing.hub.list()).toEqual([])
	})

	it('closes the host terminal when the hub cannot watch it', async () => {
		const t = setup()
		t.client.attach = async () => {
			throw new Error('attach refused')
		}
		await expect(t.hub.open(shell)).rejects.toThrow('attach refused')
		expect(t.client.calls).toContain(`close:${HOST_A}`)
		expect(t.hub.list()).toEqual([])
	})

	it('reports whether terminals are available for a project', async () => {
		const t = setup()
		expect(await t.hub.availability('p1')).toEqual({ available: true })
		t.client.available = false
		expect(await t.hub.availability('p1')).toEqual({
			available: false,
			reason: 'node-pty is not installed',
		})
		expect((await t.hub.availability('nope')).available).toBe(false)
		t.connection.terminals = false
		expect((await t.hub.availability('p1')).reason).toMatch(/no terminals/)
	})
})

describe('views of a terminal', () => {
	it('sends output only to windows that have the terminal open, once each', async () => {
		const t = setup()
		await t.hub.open(shell)
		await t.hub.attach(TAB_A, 'view-1', 'w1', { writer: true })
		await t.hub.attach(TAB_A, 'view-2', 'w1')
		await t.hub.attach(TAB_A, 'view-3', 'w2')
		t.client.emit('data', { terminalId: HOST_A, offset: 10, data: 'hello' })
		expect(t.sent).toEqual([
			{ windowId: 'w1', event: { kind: 'data', tabId: TAB_A, offset: 10, data: 'hello' } },
			{ windowId: 'w2', event: { kind: 'data', tabId: TAB_A, offset: 10, data: 'hello' } },
		])
		await t.hub.detach(TAB_A, 'view-3', 'w2')
		t.client.emit('data', { terminalId: HOST_A, offset: 15, data: '!' })
		expect(t.sent.filter((item) => item.windowId === 'w2')).toHaveLength(1)
	})

	it('registers the view before the answer so nothing that follows it is missed', async () => {
		const t = setup()
		await t.hub.open(shell)
		const original = t.client.attach
		t.client.attach = async (...args: Parameters<typeof original>) => {
			t.client.emit('data', { terminalId: HOST_A, offset: 10, data: 'in-flight' })
			return original(...args)
		}
		await t.hub.attach(TAB_A, 'view-1', 'w1')
		expect(t.sent.map((item) => item.event)).toEqual([
			{ kind: 'data', tabId: TAB_A, offset: 10, data: 'in-flight' },
		])
	})

	it('forgets a view whose first attach failed', async () => {
		const t = setup()
		await t.hub.open(shell)
		const original = t.client.attach
		t.client.attach = async () => {
			throw new Error('Another view is typing in this terminal.')
		}
		await expect(t.hub.attach(TAB_A, 'v', 'w1', { writer: true })).rejects.toThrow(/typing/)
		t.client.attach = original
		t.client.emit('data', { terminalId: HOST_A, offset: 10, data: 'x' })
		expect(t.sent).toEqual([])
	})

	it('lets only the window that opened a view write and resize through it', async () => {
		const t = setup()
		await t.hub.open(shell)
		await t.hub.attach(TAB_A, 'v', 'w1', { writer: true })
		await t.hub.write(TAB_A, 'v', 'w1', 'ls\r')
		await t.hub.resize(TAB_A, 'v', 'w1', 120, 40)
		expect(t.client.calls).toContain(`write:${HOST_A}:v:ls\r`)
		expect(t.client.calls).toContain(`resize:${HOST_A}:v:120x40`)
		await expect(t.hub.write(TAB_A, 'v', 'w2', 'x')).rejects.toThrow(/has not opened/)
		await expect(t.hub.write(TAB_A, 'other', 'w1', 'x')).rejects.toThrow(/has not opened/)
		await expect(t.hub.write(TAB_A, 'v', 'w1', '')).rejects.toThrow(/input/)
		await expect(t.hub.resize(TAB_A, 'v', 'w1', 1.5, 3)).rejects.toThrow(/width/)
		await expect(t.hub.write('conversation-1', 'v', 'w1', 'x')).rejects.toThrow()
		await expect(t.hub.attach(TAB_B, 'v', 'w1')).rejects.toThrow(/not open/)
	})

	it('answers an attach to an ended session with its saved screen and no host call', async () => {
		const t = setup()
		t.hub.restore(
			[
				{
					view: {
						id: TAB_A,
						projectId: 'p1',
						kind: 'shell',
						title: 'zsh',
						status: 'exited',
						exitCode: 0,
						createdAt: 1,
					},
					screen: 'LAST SCREEN',
				},
			],
			new Set([TAB_A]),
		)
		const view = await t.hub.attach(TAB_A, 'v', 'w1', { writer: true })
		expect(view).toMatchObject({
			mode: 'snapshot',
			screen: 'LAST SCREEN',
			writer: false,
			status: 'exited',
			exitCode: 0,
		})
		expect(t.client.calls).toEqual([])
		await expect(t.hub.write(TAB_A, 'v', 'w1', 'x')).rejects.toThrow(/ended/)
	})
})

describe('keeping the keyboard and the folder honest', () => {
	it('releases the views of a window that reloaded so the new page can take the keyboard', async () => {
		const t = setup()
		await t.hub.open(shell)
		await t.hub.attach(TAB_A, 'old', 'w1', { writer: true })
		t.hub.releaseWindow('w1')
		expect(t.client.calls).toContain(`detach:${HOST_A}:old`)
		await expect(t.hub.write(TAB_A, 'old', 'w1', 'x')).rejects.toThrow(/has not opened/)
		await t.hub.attach(TAB_A, 'old', 'w2')
		t.sent.length = 0
		t.client.emit('data', { terminalId: HOST_A, offset: 0, data: 'a' })
		expect(t.sent.map((item) => item.windowId)).toEqual(['w2'])
	})

	it('waits for the folder check before it opens or reports availability', async () => {
		let changed = true
		const t = setup({
			projectHost: async () => {
				if (changed)
					throw new Error('This folder’s automatic settings changed. Review and trust it again.')
				throw new Error('unreachable')
			},
		})
		await expect(t.hub.open(shell)).rejects.toThrow(/settings changed/)
		expect(await t.hub.availability('p1')).toMatchObject({
			available: false,
			reason: expect.stringContaining('settings changed'),
		})
		changed = false
		expect(t.client.created).toEqual([])
	})

	it('does not count the echo of a keystroke as work', async () => {
		const t = setup()
		await t.hub.open(engine)
		await t.hub.attach(TAB_A, 'v', 'w1', { writer: true })
		t.advance(ACTIVITY_WORKING_MS)
		expect(t.hub.list()[0]?.activity).toBe('waiting')
		await t.hub.write(TAB_A, 'v', 'w1', 'a')
		t.advance(50)
		t.client.emit('data', { terminalId: HOST_A, offset: 0, data: 'a' })
		t.advance(ACTIVITY_WORKING_MS)
		expect(t.hub.list()[0]?.activity).toBe('waiting')
		t.advance(1_000)
		t.client.emit('data', { terminalId: HOST_A, offset: 1, data: 'reply' })
		expect(t.hub.list()[0]?.activity).toBe('working')
	})
})

describe('an ending', () => {
	it('marks the tab, tells the windows and keeps the last screen', async () => {
		const t = setup()
		await t.hub.open(engine)
		await t.hub.attach(TAB_A, 'v', 'w1')
		t.client.emit('exit', { terminalId: HOST_A, exitCode: 3 })
		expect(t.hub.list()[0]).toMatchObject({ status: 'exited', exitCode: 3, activity: 'exited' })
		expect(t.sent.at(-1)).toEqual({
			windowId: 'w1',
			event: { kind: 'exit', tabId: TAB_A, exitCode: 3 },
		})
		await settle()
		expect(t.saves.at(-1)?.[0]).toMatchObject({
			view: { status: 'exited', exitCode: 3 },
			screen: 'SCREEN',
		})
		// The ticker has nothing left to watch.
		expect(t.repeaters.size).toBe(0)
	})

	it('treats the loss of the host process as an end with no exit code', async () => {
		const t = setup()
		await t.hub.open(shell)
		await t.hub.attach(TAB_A, 'v', 'w1')
		t.connection.emit('closed')
		expect(t.hub.list()[0]).toMatchObject({ status: 'exited' })
		expect(t.sent.at(-1)?.event).toEqual({ kind: 'exit', tabId: TAB_A })
		expect(t.client.disposed).toBe(true)
		await expect(t.hub.write(TAB_A, 'v', 'w1', 'x')).rejects.toThrow(/ended/)
	})

	it('closing a tab ends its terminal and forgets it', async () => {
		const t = setup()
		await t.hub.open(shell)
		await t.hub.close(TAB_A)
		expect(t.client.calls).toContain(`close:${HOST_A}`)
		expect(t.hub.list()).toEqual([])
		expect(t.saves.at(-1)).toEqual([])
		await t.hub.close(TAB_A)
		await expect(t.hub.attach(TAB_A, 'v', 'w1')).rejects.toThrow(/not open/)
	})

	it('closes every terminal of a removed project', async () => {
		const t = setup()
		await t.hub.open(shell)
		await t.hub.open(engine)
		expect(await t.hub.closeProject('p1')).toEqual([TAB_A, TAB_B])
		expect(t.hub.list()).toEqual([])
		expect(await t.hub.closeProject('p1')).toEqual([])
	})
})

describe('the badge of an engine tab', () => {
	it('moves from working to waiting to idle on the clock and back on output', async () => {
		const t = setup()
		await t.hub.open(engine)
		const activity = () => t.hub.list()[0]?.activity
		t.client.emit('data', { terminalId: HOST_A, offset: 0, data: 'thinking' })
		expect(activity()).toBe('working')
		t.advance(ACTIVITY_WORKING_MS)
		expect(activity()).toBe('waiting')
		expect(t.published.at(-1)?.[0]?.activity).toBe('waiting')
		t.advance(ACTIVITY_IDLE_MS)
		expect(activity()).toBe('idle')
		const before = t.published.length
		t.advance(1000)
		expect(t.published.length).toBe(before)
		t.client.emit('data', { terminalId: HOST_A, offset: 8, data: 'again' })
		expect(activity()).toBe('working')
	})

	it('counts the start as activity, so a program that prints before anyone watches is waiting once it is quiet', async () => {
		const t = setup()
		await t.hub.open(engine)
		expect(t.hub.list()[0]?.activity).toBe('working')
		t.advance(ACTIVITY_WORKING_MS)
		expect(t.hub.list()[0]?.activity).toBe('waiting')
	})

	it('has no badge on a plain shell and no ticker while only shells run', async () => {
		const t = setup()
		await t.hub.open(shell)
		expect(t.repeaters.size).toBe(0)
		t.client.emit('data', { terminalId: HOST_A, offset: 0, data: 'x' })
		t.advance(ACTIVITY_IDLE_MS)
		expect(t.hub.list()[0]?.activity).toBeUndefined()
	})
})

describe('keeping tabs between runs', () => {
	it('saves a fresh screen a little after output stops', async () => {
		const t = setup()
		await t.hub.open(shell)
		const before = t.saves.length
		t.client.emit('data', { terminalId: HOST_A, offset: 0, data: 'a' })
		t.client.emit('data', { terminalId: HOST_A, offset: 1, data: 'b' })
		expect(t.saves.length).toBe(before)
		t.fire()
		await settle()
		expect(t.saves.length).toBe(before + 1)
		expect(t.saves.at(-1)?.[0]?.screen).toBe('SCREEN')
	})

	it('brings back tabs the layout still holds as ended and names the layout tabs with nothing behind them', () => {
		const t = setup()
		const saved = (id: string, status: 'running' | 'exited'): SavedTerminalTab => ({
			view: { id, projectId: 'p1', kind: 'shell', title: 'zsh', status, createdAt: 1 },
			screen: 'S',
		})
		const orphans = t.hub.restore(
			[saved(TAB_A, 'running'), saved(TAB_B, 'exited')],
			new Set([TAB_A, terminalTabId('2f0e0d0c-0b0a-4908-8706-050403020102')]),
		)
		expect(orphans).toEqual([terminalTabId('2f0e0d0c-0b0a-4908-8706-050403020102')])
		expect(t.hub.list().map((tab) => tab.id)).toEqual([TAB_A])
		// Only the tab in the layout is kept in the file.
		expect(t.saves.at(-1)?.map((tab) => tab.view.id)).toEqual([TAB_A])
	})

	it('forgets all of them when the setting says not to restore', () => {
		const t = setup({ settings: () => ({ terminalShell: 'auto', restoreTerminals: false }) })
		const orphans = t.hub.restore(
			[
				{
					view: {
						id: TAB_A,
						projectId: 'p1',
						kind: 'shell',
						title: 'zsh',
						status: 'running',
						createdAt: 1,
					},
					screen: '',
				},
			],
			new Set([TAB_A]),
		)
		expect(orphans).toEqual([TAB_A])
		expect(t.hub.list()).toEqual([])
		expect(t.saves.at(-1)).toEqual([])
	})

	it('saves a screen at least every so often while output never pauses', async () => {
		const t = setup()
		await t.hub.open(shell)
		const before = t.saves.length
		for (let index = 0; index < 5; index++) {
			t.client.emit('data', { terminalId: HOST_A, offset: index, data: 'x' })
			t.advance(2_900)
		}
		// Each chunk re-armed the quiet timer, so only the bounded wait can have saved.
		t.fire()
		await settle()
		expect(t.saves.length).toBeGreaterThan(before)
	})

	it('keeps nothing and removes what was kept while the setting is off', async () => {
		let restore = true
		const t = setup({ settings: () => ({ terminalShell: 'auto', restoreTerminals: restore }) })
		await t.hub.open(shell)
		expect(t.saves.at(-1)).toHaveLength(1)
		restore = false
		t.hub.settingsChanged()
		expect(t.saves.at(-1)).toEqual([])
		const before = t.saves.length
		t.client.emit('data', { terminalId: HOST_A, offset: 0, data: 'secret' })
		t.fire()
		await settle()
		await t.hub.shutdown()
		expect(t.saves.slice(before).every((tabs) => tabs.length === 0)).toBe(true)
		expect(
			t.client.calls.filter((call) => call.startsWith(`attach:${HOST_A}:desktop`)),
		).toHaveLength(1)
	})

	it('writes the screens once more on shutdown and releases the clients', async () => {
		const t = setup()
		await t.hub.open(shell)
		await t.hub.shutdown()
		expect(t.saves.at(-1)?.[0]?.screen).toBe('SCREEN')
		expect(t.client.disposed).toBe(true)
	})
})

describe('a command Namzu chose', () => {
	const launch = {
		command: '/bin/npm',
		args: ['install', '-g', 'pkg@latest'],
		title: 'Updating pkg',
	}

	it('opens as a shell tab running exactly that program', async () => {
		const t = setup()
		const result = await t.hub.openCommand({ projectId: 'p1', launch, cols: 100, rows: 30 })
		expect(t.client.created[0]).toMatchObject({
			cwd: '/work/api',
			command: '/bin/npm',
			args: ['install', '-g', 'pkg@latest'],
			title: 'Updating pkg',
		})
		expect(result.terminal).toMatchObject({
			kind: 'shell',
			title: 'Updating pkg',
			status: 'running',
		})
		expect(result.terminal.activity).toBeUndefined()
	})

	it('tells its owner how it ended, once, with the end of its output', async () => {
		const ends: TerminalEndInfo[] = []
		const t = setup({ onEnd: (info) => ends.push(info) })
		await t.hub.openCommand({ projectId: 'p1', launch, cols: 100, rows: 30 })
		t.client.emit('data', { terminalId: HOST_A, offset: 0, data: 'npm ERR! EBUSY\n' })
		t.client.emit('exit', { terminalId: HOST_A, exitCode: 1 })
		t.client.emit('exit', { terminalId: HOST_A, exitCode: 1 })
		expect(ends).toEqual([{ tabId: TAB_A, exitCode: 1, tail: 'npm ERR! EBUSY\n' }])
	})

	it('keeps only the end of a long output', async () => {
		const ends: TerminalEndInfo[] = []
		const t = setup({ onEnd: (info) => ends.push(info) })
		await t.hub.openCommand({ projectId: 'p1', launch, cols: 100, rows: 30 })
		for (let index = 0; index < 5; index++)
			t.client.emit('data', {
				terminalId: HOST_A,
				offset: index,
				data: `${'x'.repeat(2_000)}${index}`,
			})
		t.client.emit('exit', { terminalId: HOST_A, exitCode: 0 })
		expect(ends[0]?.tail.length).toBe(4_000)
		expect(ends[0]?.tail.endsWith('4')).toBe(true)
	})

	it('reports a tab closed before the program ended, and a lost host', async () => {
		const ends: TerminalEndInfo[] = []
		const t = setup({ onEnd: (info) => ends.push(info) })
		await t.hub.openCommand({ projectId: 'p1', launch, cols: 100, rows: 30 })
		await t.hub.close(TAB_A)
		expect(ends).toEqual([{ tabId: TAB_A, closed: true, tail: '' }])
		await t.hub.openCommand({ projectId: 'p1', launch, cols: 100, rows: 30 })
		t.connection.emit('closed')
		expect(ends.at(-1)).toEqual({ tabId: TAB_B, tail: '' })
	})

	it('says nothing about an ordinary tab', async () => {
		const ends: TerminalEndInfo[] = []
		const t = setup({ onEnd: (info) => ends.push(info) })
		await t.hub.open(shell)
		t.client.emit('exit', { terminalId: HOST_A, exitCode: 0 })
		expect(ends).toEqual([])
	})
})
