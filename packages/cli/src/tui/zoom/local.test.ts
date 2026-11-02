import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import { LocalSession } from './local.js'
import { createTerminalProxy } from './proxy.js'

class FakeStdin extends EventEmitter {
	isTTY = true
	private queue: string[] = []
	read(): string | null {
		return this.queue.shift() ?? null
	}
	setEncoding(): void {}
	setRawMode(): void {}
	press(input: string): void {
		this.queue.push(input)
		this.emit('readable')
	}
}

class FakeStdout extends EventEmitter {
	isTTY = true
	columns = 100
	rows = 30
	writes: string[] = []
	write(chunk: string): boolean {
		this.writes.push(chunk)
		return true
	}
	getWindowSize(): [number, number] {
		return [this.columns, this.rows]
	}
}

function rig() {
	const real = new FakeStdout()
	const stdin = new FakeStdin()
	const proxy = createTerminalProxy(
		real as unknown as NodeJS.WriteStream,
		stdin as unknown as NodeJS.ReadStream,
	)
	const calls = { keys: [] as string[], exits: 0, repaints: 0, changes: 0 }
	const session = new LocalSession(
		{
			proxy,
			realOut: real,
			onKey: (chunk) => {
				calls.keys.push(chunk)
				return null
			},
			requestExit: () => {
				calls.exits += 1
			},
			repaint: () => {
				calls.repaints += 1
			},
		},
		{ cols: 100, rows: 30 },
	)
	session.observe(() => {
		calls.changes += 1
	})
	return { real, stdin, proxy, session, calls }
}

describe('the local session', () => {
	it('shows what Ink writes in its mirror, at the pane’s size, and asks the App to repaint', async () => {
		const { proxy, session, real, calls } = rig()
		session.attach(70, 20)
		expect(calls.repaints).toBe(1)
		expect([proxy.stdout.columns, proxy.stdout.rows]).toEqual([70, 20])
		proxy.stdout.write('first line\nsecond line')
		await session.screen.settled()
		expect(
			session.screen
				.lines()
				.slice(0, 2)
				.map((l) => l.trimEnd()),
		).toEqual(['first line', 'second line'])
		expect(calls.changes).toBe(1)
		// Nothing of it reached the real terminal.
		expect(real.writes).toEqual([])
	})

	it('hands the host every key from the terminal, and gives Ink the keys the host forwards', async () => {
		const { proxy, session, stdin, calls } = rig()
		session.attach(70, 20)
		stdin.press('abc')
		expect(proxy.stdin.read()).toBeNull()
		expect(calls.keys).toEqual(['abc'])
		session.write('xyz')
		await Promise.resolve()
		expect(proxy.stdin.read()).toBe('xyz')
	})

	it('answers the emulator’s queries by writing the reply to Ink', async () => {
		const { proxy, session } = rig()
		session.attach(70, 20)
		// A device-attributes query is answered by the mirror and read by Ink as input.
		proxy.stdout.write('\u001b[c')
		await session.screen.settled()
		await Promise.resolve()
		const reply = proxy.stdin.read()
		expect(typeof reply).toBe('string')
	})

	it('resizes the mirror before Ink hears of it, and only while attached', () => {
		const { proxy, session } = rig()
		session.resize(90, 25)
		expect([proxy.stdout.columns, proxy.stdout.rows]).toEqual([100, 30])
		session.attach(70, 20)
		const seen: [number, number][] = []
		proxy.stdout.on('resize', () => {
			seen.push([session.screen.cells().cols, proxy.stdout.columns])
		})
		session.resize(60, 18)
		expect(seen).toEqual([[60, 60]])
		expect([proxy.stdout.columns, proxy.stdout.rows]).toEqual([60, 18])
	})

	it('gives the real terminal back at full size with its modes as Ink left them, and repaints', () => {
		const { proxy, session, real, calls } = rig()
		proxy.stdout.write('\u001b[?25l\u001b[?2004h')
		session.attach(70, 20)
		proxy.stdout.write('\u001b[?25h')
		calls.repaints = 0
		session.detach()
		// The cursor Ink hid before the switch and showed inside the mirror: the last word is the mirror’s.
		expect(real.writes.join('')).toContain('\u001b[?2004h')
		expect(real.writes.join('')).toContain('\u001b[?25h')
		expect([proxy.stdout.columns, proxy.stdout.rows]).toEqual([100, 30])
		expect(proxy.mode).toBe('direct')
		expect(calls.repaints).toBe(1)
		// Output goes to the terminal again.
		proxy.stdout.write('after')
		expect(real.writes.at(-1)).toBe('after')
	})

	it('has a fresh mirror each time it is shown', async () => {
		const { proxy, session } = rig()
		session.attach(70, 20)
		proxy.stdout.write('old')
		await session.screen.settled()
		session.detach()
		session.attach(70, 20)
		await session.screen.settled()
		expect(session.screen.lines().join('').trim()).toBe('')
	})

	it('ends the conversation like /exit when the host stops it, and goes quiet once it is over', async () => {
		const { proxy, session, calls } = rig()
		session.attach(70, 20)
		session.stop()
		expect(calls.exits).toBe(1)
		session.markExited()
		expect(session.status).toBe('exited')
		expect(session.ending).toBe('finished')
		expect(proxy.mode).toBe('direct')
		session.stop()
		session.write('late')
		await Promise.resolve()
		expect(calls.exits).toBe(1)
		expect(proxy.stdin.read()).toBeNull()
	})
})
