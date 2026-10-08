import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type TerminalEvent, TerminalManager } from '../manager.js'
import { type CreateRequest, TERMINAL_LIMITS } from '../protocol.js'
import { fakeBinding, manualDefer } from './support/fake-pty.js'

const request = (over: Partial<CreateRequest> = {}): CreateRequest => ({
	args: [],
	env: {},
	cols: 80,
	rows: 24,
	command: 'fake-shell',
	...over,
})

/** Lets the promise steps queued so far run; no clock is involved. */
async function ticks(): Promise<void> {
	for (let index = 0; index < 8; index++) await Promise.resolve()
}

function setup(
	options: {
		ringCapacity?: number
		platform?: NodeJS.Platform
		descendants?: (pid: number) => Promise<number[]>
		signalled?: number[]
		cwd?: string
	} = {},
) {
	const { binding, spawned } = fakeBinding()
	const events: TerminalEvent[] = []
	const flush = manualDefer()
	const timers: { run: () => void; ms: number; cleared: boolean }[] = []
	const manager = new TerminalManager({
		loadPty: async () => binding,
		emit: (event) => events.push(event),
		cwd: options.cwd ?? process.cwd(),
		env: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', HOME: '/home/x' },
		platform: options.platform ?? 'linux',
		defer: flush.defer,
		now: () => 1_700_000_000_000,
		killGraceMs: 50,
		// No real process exists for a fake pid; nothing is listed or signalled unless a test says so.
		descendants: options.descendants ?? (async () => []),
		signalProcess: (pid) => void options.signalled?.push(pid),
		timers: {
			setTimeout: (run, ms) => {
				const timer = { run, ms, cleared: false }
				timers.push(timer)
				return timer
			},
			clearTimeout: (handle) => {
				;(handle as { cleared: boolean }).cleared = true
			},
		},
		...(options.ringCapacity ? { ringCapacity: options.ringCapacity } : {}),
	})
	const data = () => events.flatMap((event) => (event.type === 'data' ? [event.params] : []))
	return { manager, spawned, events, flush, timers, data }
}

const attach = (
	manager: TerminalManager,
	id: string,
	viewerId: string,
	extra: Partial<{ fromOffset: number; writer: boolean; force: boolean }> = {},
) => manager.attach({ terminalId: id, viewerId, writer: false, force: false, ...extra })

describe('creating', () => {
	it('starts the program in the project folder with a terminal environment', async () => {
		const { manager, spawned } = setup()
		const info = await manager.create(request({ args: ['-l'], title: 'Build' }))
		expect(spawned).toHaveLength(1)
		expect(spawned[0]?.file).toBe('fake-shell')
		expect(spawned[0]?.args).toEqual(['-l'])
		expect(spawned[0]?.options).toMatchObject({ cols: 80, rows: 24, cwd: process.cwd() })
		expect(spawned[0]?.options.env.TERM).toBe('xterm-256color')
		// The variable that makes this host run as a plain interpreter stays out of a shell.
		expect(spawned[0]?.options.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
		expect(spawned[0]?.options.env.HOME).toBe('/home/x')
		expect(info).toMatchObject({
			title: 'Build',
			status: 'running',
			pid: 1000,
			offset: 0,
			writerHeld: false,
			createdAt: 1_700_000_000_000,
		})
	})

	it('lets the caller set and remove variables, and pass the host variable on purpose', async () => {
		const { manager, spawned } = setup()
		await manager.create(request({ env: { HOME: null, ELECTRON_RUN_AS_NODE: '1', X: 'y' } }))
		const env = spawned[0]?.options.env
		expect(env?.HOME).toBeUndefined()
		expect(env?.ELECTRON_RUN_AS_NODE).toBe('1')
		expect(env?.X).toBe('y')
	})

	it('uses the shell when no program is named', async () => {
		const { manager, spawned } = setup()
		await manager.create({ ...request(), command: undefined })
		expect(spawned[0]?.file).toBe('/bin/sh')
	})

	it('refuses a folder outside the project, a relative one, and a missing one', async () => {
		const { manager } = setup()
		await expect(manager.create(request({ cwd: '/' }))).rejects.toThrow(/project folder or below/)
		await expect(manager.create(request({ cwd: 'sub' }))).rejects.toThrow(/absolute/)
		await expect(
			manager.create(request({ cwd: `${process.cwd()}/does-not-exist` })),
		).rejects.toThrow(/does not exist/)
		await expect(manager.create(request({ cwd: `${process.cwd()}-sibling` }))).rejects.toThrow(
			/project folder or below/,
		)
	})

	it.skipIf(process.platform === 'win32')(
		'refuses a link inside the project that leads out of it',
		async () => {
			const project = mkdtempSync(join(tmpdir(), 'namzu-term-project-'))
			const outside = mkdtempSync(join(tmpdir(), 'namzu-term-outside-'))
			mkdirSync(join(project, 'inside'))
			symlinkSync(outside, join(project, 'escape'))
			const { manager } = setup({ cwd: project })
			await expect(manager.create(request({ cwd: join(project, 'escape') }))).rejects.toThrow(
				/project folder or below/,
			)
			await expect(manager.create(request({ cwd: join(project, 'inside') }))).resolves.toBeDefined()
		},
	)

	it('accepts a folder below the project', async () => {
		const { manager } = setup()
		const info = await manager.create(request({ cwd: `${process.cwd()}/src` }))
		expect(info.cwd).toBe(`${process.cwd()}/src`)
	})

	it('says what failed when the program cannot start', async () => {
		const { manager } = setup()
		const failing = new TerminalManager({
			loadPty: async () => ({
				spawn: () => {
					throw new Error('File not found: nope')
				},
			}),
			emit: () => undefined,
			cwd: process.cwd(),
		})
		await expect(failing.create(request({ command: '/usr/bin/nope' }))).rejects.toThrow(
			/Could not start nope: File not found/,
		)
		expect(manager.list()).toEqual([])
	})

	it('keeps a bounded number of terminals and makes room from the ended ones', async () => {
		const { manager, spawned } = setup()
		for (let i = 0; i < TERMINAL_LIMITS.maxTerminals; i++) await manager.create(request())
		await expect(manager.create(request())).rejects.toThrow(/already has/)
		spawned[0]?.end(0)
		await manager.create(request())
		expect(manager.list()).toHaveLength(TERMINAL_LIMITS.maxTerminals)
	})

	it('does not cache a failed load', async () => {
		let attempts = 0
		const { binding } = fakeBinding()
		const manager = new TerminalManager({
			loadPty: async () => {
				attempts += 1
				if (attempts === 1) throw new Error('not installed')
				return binding
			},
			emit: () => undefined,
			cwd: process.cwd(),
		})
		expect(await manager.available()).toEqual({ available: false, reason: 'not installed' })
		expect(await manager.available()).toEqual({ available: true })
	})
})

describe('output', () => {
	it('announces output to attached views in order, as bounded chunks, once per turn', async () => {
		const { manager, spawned, flush, data } = setup()
		const info = await manager.create(request())
		attach(manager, info.id, 'a')
		spawned[0]?.print('one ')
		spawned[0]?.print('two ')
		expect(data()).toEqual([])
		flush.run()
		expect(data()).toEqual([{ terminalId: info.id, offset: 0, data: 'one two ' }])
		const big = 'x'.repeat(TERMINAL_LIMITS.maxChunk * 2 + 5)
		spawned[0]?.print(big)
		flush.run()
		const chunks = data().slice(1)
		expect(chunks.map((chunk) => chunk.data.length)).toEqual([
			TERMINAL_LIMITS.maxChunk,
			TERMINAL_LIMITS.maxChunk,
			5,
		])
		expect(chunks.map((chunk) => chunk.offset)).toEqual([
			8,
			8 + TERMINAL_LIMITS.maxChunk,
			8 + TERMINAL_LIMITS.maxChunk * 2,
		])
	})

	it('does not split a surrogate pair across chunks', async () => {
		const { manager, spawned, flush, data } = setup()
		const info = await manager.create(request())
		attach(manager, info.id, 'a')
		spawned[0]?.print(`${'x'.repeat(TERMINAL_LIMITS.maxChunk - 1)}😀tail`)
		flush.run()
		const [first, second] = data()
		expect(first?.data.length).toBe(TERMINAL_LIMITS.maxChunk - 1)
		expect(second?.data.startsWith('😀')).toBe(true)
		expect(`${first?.data}${second?.data}`).toBe(
			`${'x'.repeat(TERMINAL_LIMITS.maxChunk - 1)}😀tail`,
		)
	})

	it('announces nothing while no view is attached, and still keeps the output', async () => {
		const { manager, spawned, flush, data } = setup()
		await manager.create(request())
		spawned[0]?.print('quiet')
		flush.run()
		expect(data()).toEqual([])
		expect(manager.list()[0]?.offset).toBe(5)
	})

	it('reports the exit after the last output, and keeps the terminal listed', async () => {
		const { manager, spawned, flush, events } = setup()
		const info = await manager.create(request())
		attach(manager, info.id, 'a')
		spawned[0]?.print('bye')
		spawned[0]?.end(3, 15)
		expect(events.map((event) => event.type)).toEqual(['data', 'exit'])
		expect(events[1]).toEqual({
			type: 'exit',
			params: { terminalId: info.id, exitCode: 3, signal: 15 },
		})
		expect(manager.list()[0]).toMatchObject({ status: 'exited', exitCode: 3, signal: 15 })
		flush.run()
	})
})

describe('attaching', () => {
	it('replays from an offset the ring still holds', async () => {
		const { manager, spawned } = setup()
		const info = await manager.create(request())
		spawned[0]?.print('hello world')
		const result = attach(manager, info.id, 'a', { fromOffset: 6 })
		expect(result).toMatchObject({ mode: 'replay', screen: '', data: 'world', start: 6, end: 11 })
		expect(attach(manager, info.id, 'a', { fromOffset: 11 })).toMatchObject({
			mode: 'replay',
			data: '',
			start: 11,
			end: 11,
		})
	})

	it('falls back to a snapshot when the offset is gone or absent', async () => {
		const { manager, spawned } = setup({ ringCapacity: 10 })
		const info = await manager.create(request({ cols: 20, rows: 5 }))
		spawned[0]?.print('first line\r\nsecond line\r\n')
		const fresh = attach(manager, info.id, 'a')
		expect(fresh.mode).toBe('snapshot')
		expect(fresh.end).toBe(25)
		const stale = attach(manager, info.id, 'b', { fromOffset: 0 })
		expect(stale.mode).toBe('snapshot')
	})

	it('a snapshot plus the data after it rebuilds the screen exactly', async () => {
		const { manager, spawned } = setup()
		const info = await manager.create(request({ cols: 30, rows: 6 }))
		spawned[0]?.print('alpha\r\nbeta\r\n')
		await manager.screenSettled(info.id)
		spawned[0]?.print('gamma')
		const result = attach(manager, info.id, 'a')
		const lines = manager.screenLines(info.id)
		expect(result.mode).toBe('snapshot')
		// Whatever the emulator had not yet parsed travels as data, so the two never overlap.
		expect(result.start + result.data.length).toBe(result.end)
		expect(result.screen.includes('alpha')).toBe(true)
		expect(lines.slice(0, 2)).toEqual(['alpha', 'beta'])
	})

	it('gives the keyboard to one view at a time', async () => {
		const { manager } = setup()
		const info = await manager.create(request())
		expect(attach(manager, info.id, 'a', { writer: true }).writer).toBe(true)
		expect(() => attach(manager, info.id, 'b', { writer: true })).toThrow(/typing in this terminal/)
		expect(attach(manager, info.id, 'b').writer).toBe(false)
		expect(attach(manager, info.id, 'b', { writer: true, force: true }).writer).toBe(true)
		expect(manager.list()[0]?.writerHeld).toBe(true)
		manager.detach({ terminalId: info.id, viewerId: 'b' })
		expect(manager.list()[0]?.writerHeld).toBe(false)
	})

	it('refuses an unknown terminal', () => {
		const { manager } = setup()
		expect(() => attach(manager, '00000000-0000-4000-8000-000000000000', 'a')).toThrow(/not open/)
	})
})

describe('input', () => {
	it('lets only the writer type or resize', async () => {
		const { manager, spawned } = setup()
		const info = await manager.create(request())
		attach(manager, info.id, 'a', { writer: true })
		attach(manager, info.id, 'b')
		manager.write({ terminalId: info.id, viewerId: 'a', data: 'ls\r' })
		expect(spawned[0]?.writes).toEqual(['ls\r'])
		expect(() => manager.write({ terminalId: info.id, viewerId: 'b', data: 'rm' })).toThrow(
			/does not hold the keyboard/,
		)
		manager.resize({ terminalId: info.id, viewerId: 'a', cols: 100, rows: 40 })
		manager.resize({ terminalId: info.id, viewerId: 'a', cols: 100, rows: 40 })
		expect(spawned[0]?.resizes).toEqual([{ cols: 100, rows: 40 }])
		expect(manager.list()[0]).toMatchObject({ cols: 100, rows: 40 })
		expect(() =>
			manager.resize({ terminalId: info.id, viewerId: 'b', cols: 10, rows: 10 }),
		).toThrow()
	})

	it('refuses input once the program has ended', async () => {
		const { manager, spawned } = setup()
		const info = await manager.create(request())
		attach(manager, info.id, 'a', { writer: true })
		spawned[0]?.end(0)
		expect(() => manager.write({ terminalId: info.id, viewerId: 'a', data: 'x' })).toThrow(/ended/)
		expect(manager.list()[0]?.writerHeld).toBe(false)
	})
})

describe('flow control', () => {
	it('pauses the program when output is not being acknowledged and resumes when it is', async () => {
		const { manager, spawned, flush } = setup()
		const info = await manager.create(request())
		attach(manager, info.id, 'a')
		spawned[0]?.print('y'.repeat(TERMINAL_LIMITS.flowHigh + 1))
		flush.run()
		expect(spawned[0]?.pauses).toBe(1)
		// Still more than the low-water mark outstanding: stays paused.
		manager.ack({ terminalId: info.id, offset: 10 })
		expect(spawned[0]?.resumes).toBe(0)
		manager.ack({ terminalId: info.id, offset: TERMINAL_LIMITS.flowHigh + 1 })
		expect(spawned[0]?.resumes).toBe(1)
	})

	it('never pauses for a terminal nobody is watching, and resumes if the last view leaves', async () => {
		const { manager, spawned, flush } = setup()
		const info = await manager.create(request())
		spawned[0]?.print('y'.repeat(TERMINAL_LIMITS.flowHigh * 2))
		flush.run()
		expect(spawned[0]?.pauses).toBe(0)
		attach(manager, info.id, 'a')
		spawned[0]?.print('z'.repeat(TERMINAL_LIMITS.flowHigh + 1))
		flush.run()
		expect(spawned[0]?.pauses).toBe(1)
		manager.detach({ terminalId: info.id, viewerId: 'a' })
		expect(spawned[0]?.resumes).toBe(1)
	})

	it('ignores an acknowledgement of output that was never sent', async () => {
		const { manager, spawned, flush } = setup()
		const info = await manager.create(request())
		attach(manager, info.id, 'a')
		spawned[0]?.print('y'.repeat(TERMINAL_LIMITS.flowHigh + 1))
		flush.run()
		manager.ack({ terminalId: info.id, offset: Number.MAX_SAFE_INTEGER })
		// Clamped to what was sent: this is a full acknowledgement, not an overflow.
		expect(spawned[0]?.resumes).toBe(1)
	})
})

describe('ending', () => {
	it('stops the whole tree politely, then by force if the program holds on', async () => {
		const { manager, spawned, timers } = setup()
		const info = await manager.create(request())
		const killed = manager.kill(info.id)
		await ticks()
		expect(timers).toHaveLength(1)
		expect(timers[0]?.ms).toBe(50)
		// No real process group exists for the fake pid; the program itself is signalled.
		expect(spawned[0]?.kills).toContain('SIGHUP')
		timers[0]?.run()
		expect(spawned[0]?.kills).toContain('SIGKILL')
		spawned[0]?.end(0, 9)
		await killed
		expect(timers[0]?.cleared).toBe(true)
		expect(manager.list()[0]).toMatchObject({ status: 'exited', signal: 9 })
	})

	it('kills what the terminal left running after it ended, found before the polite stop', async () => {
		const signalled: number[] = []
		const order: string[] = []
		const { manager, spawned } = setup({
			signalled,
			descendants: async (pid) => {
				order.push(`listed:${pid}:${spawned[0]?.kills.length}`)
				return [2001, 2002]
			},
		})
		const info = await manager.create(request())
		const closing = manager.close(info.id)
		await ticks()
		// Listed while the program had not yet been signalled.
		expect(order).toEqual(['listed:1000:0'])
		expect(spawned[0]?.kills).toContain('SIGHUP')
		expect(signalled).toEqual([])
		spawned[0]?.end(0, 1)
		await closing
		expect(signalled).toEqual([2001, 2002])
	})

	it('does not look for survivors on Windows, where the console list is the tree', async () => {
		const listed: number[] = []
		const { manager, spawned } = setup({
			platform: 'win32',
			descendants: async (pid) => {
				listed.push(pid)
				return []
			},
		})
		const info = await manager.create(request({ cwd: undefined }))
		const closing = manager.close(info.id)
		await ticks()
		spawned[0]?.end(0)
		await closing
		expect(listed).toEqual([])
	})

	it('is idempotent and does not signal an ended program', async () => {
		const { manager, spawned } = setup()
		const info = await manager.create(request())
		spawned[0]?.end(0)
		await manager.kill(info.id)
		expect(spawned[0]?.kills).toEqual([])
	})

	it('uses the platform tree kill on Windows: the binding, then the system tool by force', async () => {
		const { manager, spawned } = setup({ platform: 'win32' })
		const info = await manager.create(request({ cwd: undefined }))
		void manager.kill(info.id)
		expect(spawned[0]?.kills).toEqual([undefined])
	})

	it('close ends a running terminal and forgets it', async () => {
		const { manager, spawned } = setup()
		const info = await manager.create(request())
		const closing = manager.close(info.id)
		spawned[0]?.end(0, 1)
		await closing
		expect(manager.list()).toEqual([])
		expect(() => attach(manager, info.id, 'a')).toThrow(/not open/)
	})

	it('closeAll ends everything, waits for it, and refuses new terminals', async () => {
		const { manager, spawned } = setup()
		await manager.create(request())
		await manager.create(request())
		const closing = manager.closeAll()
		for (const pty of spawned) pty.end(0, 1)
		await closing
		expect(manager.list()).toEqual([])
		await expect(manager.create(request())).rejects.toThrow(/closed/)
	})

	it('closeAll gives up on a program that never reports its end', async () => {
		const { manager, timers } = setup()
		await manager.create(request())
		const closing = manager.closeAll()
		// The patience timer is the one that waits four graces.
		timers.find((timer) => timer.ms === 200)?.run()
		await closing
		expect(manager.list()).toEqual([])
	})
})
