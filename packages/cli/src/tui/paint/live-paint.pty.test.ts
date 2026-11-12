/**
 * The default screen's writer on a real pseudo-terminal: what the emulator on the other side holds
 * before the program starts, after it starts, after a resize and after it leaves. No model, no
 * network, no duration: every wait is for the emulator to show the text the step produces.
 */

import { fileURLToPath } from 'node:url'

import { Terminal } from '@xterm/headless'
import { type IPty, spawn } from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'

const harness = fileURLToPath(new URL('../__tests__/support/paint-harness.tsx', import.meta.url))
const ESC = '\u001b'

class Session {
	readonly term: Terminal
	readonly pty: IPty
	raw = ''
	exitCode: number | undefined
	private readonly waiters: (() => void)[] = []
	private readonly exited: Promise<void>

	constructor(
		private cols: number,
		private rows: number,
		args: string[] = [],
	) {
		this.term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
		for (let i = 1; i <= 40; i++) this.term.write(`history ${i}\r\n`)
		this.term.write('$ harness\r\n')
		this.pty = spawn(process.execPath, ['--import', 'tsx', harness, ...args], {
			name: 'xterm-256color',
			cols,
			rows,
			env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TERM: 'xterm-256color' },
		})
		this.pty.onData((data) => {
			this.raw += data
			this.term.write(data, () => {
				for (const wake of this.waiters.splice(0)) wake()
			})
		})
		this.exited = new Promise((resolve) => {
			this.pty.onExit(({ exitCode }) => {
				this.exitCode = exitCode
				resolve()
			})
		})
	}

	screen(): string[] {
		const buffer = this.term.buffer.active
		const rows: string[] = []
		for (let i = 0; i < buffer.baseY + this.rows; i++)
			rows.push(buffer.getLine(i)?.translateToString(true) ?? '')
		while (rows.at(-1) === '') rows.pop()
		return rows
	}

	/** Resolves when the emulator's screen satisfies `ready`, checking after every write it parses. */
	async until(ready: (rows: string[]) => boolean): Promise<string[]> {
		for (;;) {
			const rows = this.screen()
			if (ready(rows)) return rows
			await new Promise<void>((resolve) => this.waiters.push(resolve))
		}
	}

	send(line: string): void {
		this.pty.write(`${line}\r`)
	}

	resize(cols: number, rows: number): void {
		this.cols = cols
		this.rows = rows
		this.term.resize(cols, rows)
		this.pty.resize(cols, rows)
	}

	async ended(): Promise<void> {
		await this.exited
	}

	/** Whether the last cursor mode the program wrote shows the cursor. */
	cursorShown(): boolean {
		return this.raw.lastIndexOf(`${ESC}[?25h`) > this.raw.lastIndexOf(`${ESC}[?25l`)
	}

	kill(): void {
		if (this.exitCode === undefined) this.pty.kill()
	}
}

const history = Array.from({ length: 40 }, (_, i) => `history ${i + 1}`)
const count = (rows: string[], text: string): number => rows.filter((r) => r === text).length

// A real subprocess (a TypeScript loader, a pseudo-terminal) is legitimately slow to start on a loaded
// machine, so these two carry a longer budget than the unit default. What they wait for is the emulator.
const SLOW_START_MS = 60_000

describe('the default screen on a pseudo-terminal', () => {
	let session: Session | undefined
	afterEach(() => session?.kill())

	it(
		'starts under what was on screen, keeps it through a resize, and gives the cursor back on a clean line',
		async () => {
			session = new Session(60, 14)
			let rows = await session.until((r) => r.includes('live: ready'))
			// Launch: the shell's lines and the scrollback above are all still there.
			expect(rows.slice(0, 41)).toEqual([...history, '$ harness'])
			expect(session.raw).not.toContain(`${ESC}[3J`)
			expect(session.raw).not.toContain(`${ESC}[2J`)

			session.send('row alpha')
			session.send('row beta')
			rows = await session.until((r) => r.includes('beta'))
			expect(count(rows, 'alpha')).toBe(1)

			// A resize: the printed rows stay, and are not printed again; the region is drawn once at the new width.
			const before = session.raw.length
			session.resize(40, 14)
			rows = await session.until((r) => r.includes('cols 40'))
			const sent = session.raw.slice(before)
			expect(sent).not.toContain(`${ESC}[3J`)
			expect(sent).not.toContain(`${ESC}[2J`)
			expect(rows.slice(0, 41)).toEqual([...history, '$ harness'])
			expect(count(rows, 'alpha')).toBe(1)
			expect(count(rows, 'beta')).toBe(1)
			expect(count(rows, 'live: ready')).toBe(1)
			expect(rows.filter((r) => r.startsWith('---')).every((r) => r.length <= 39)).toBe(true)
			expect(rows.at(-1)).toBe('cols 40')

			// Leaving: the cursor is shown, at the start of a line under the last frame.
			session.send('quit')
			await session.ended()
			expect(session.exitCode).toBe(0)
			expect(session.cursorShown()).toBe(true)
			const buffer = session.term.buffer.active
			expect(buffer.cursorX).toBe(0)
			expect(session.screen().at(-1)).toBe('cols 40')
		},
		SLOW_START_MS,
	)

	it(
		'a process that dies without unmounting still shows the cursor and has painted the last frame',
		async () => {
			session = new Session(60, 14)
			await session.until((r) => r.includes('live: ready'))
			session.send('live last state')
			await session.until((r) => r.includes('live: last state'))
			session.send('crash')
			await session.ended()
			expect(session.exitCode).not.toBe(0)
			expect(session.cursorShown()).toBe(true)
			const rows = session.screen()
			expect(rows).toContain('live: last state')
			expect(rows.slice(0, 41)).toEqual([...history, '$ harness'])
		},
		SLOW_START_MS,
	)
})
