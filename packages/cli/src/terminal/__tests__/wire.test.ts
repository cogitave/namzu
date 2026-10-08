import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { TERMINAL_METHODS, TERMINAL_NOTIFICATIONS } from '../protocol.js'
import { loadHostPty } from '../pty.js'

/**
 * The real binary, `namzu acp --desktop`, over real pipes: the exact process the
 * desktop application spawns. It owns a real pseudo-terminal, and the only things
 * this test waits on are frames the process writes.
 */
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'bin.js')
let binding = true
try {
	await loadHostPty()
} catch {
	binding = false
}

interface Frame {
	id?: number
	method?: string
	params?: Record<string, any>
	result?: Record<string, any>
	error?: { code: number; message: string }
}

class Wire {
	readonly frames: Frame[] = []
	readonly garbage: string[] = []
	stderr = ''
	private buffer = ''
	private next = 0
	private watchers = new Set<() => void>()
	readonly exited: Promise<number | null>
	private ended = false

	constructor(readonly child: ChildProcessWithoutNullStreams) {
		child.stdout.setEncoding('utf8')
		child.stderr.setEncoding('utf8')
		child.stdout.on('data', (chunk: string) => {
			this.buffer += chunk
			for (let at = this.buffer.indexOf('\n'); at !== -1; at = this.buffer.indexOf('\n')) {
				const line = this.buffer.slice(0, at)
				this.buffer = this.buffer.slice(at + 1)
				try {
					this.frames.push(JSON.parse(line) as Frame)
				} catch {
					this.garbage.push(line)
				}
			}
			for (const wake of [...this.watchers]) wake()
		})
		child.stderr.on('data', (chunk: string) => {
			this.stderr += chunk
		})
		this.exited = new Promise((resolve) =>
			child.once('exit', (code) => {
				this.ended = true
				for (const wake of [...this.watchers]) wake()
				resolve(code)
			}),
		)
	}

	async until<T>(find: () => T | undefined): Promise<T> {
		for (;;) {
			const found = find()
			if (found !== undefined) return found
			if (this.ended) throw new Error(`The host exited. stderr:\n${this.stderr}`)
			await new Promise<void>((resolve) => {
				const wake = () => {
					this.watchers.delete(wake)
					resolve()
				}
				this.watchers.add(wake)
			})
		}
	}

	async request(
		method: string,
		params: Record<string, unknown> = {},
	): Promise<Record<string, any>> {
		const id = ++this.next
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
		const frame = await this.until(() => this.frames.find((candidate) => candidate.id === id))
		if (frame.error) throw new Error(frame.error.message)
		return frame.result ?? {}
	}

	notifications(method: string): Frame[] {
		return this.frames.filter((frame) => frame.method === method)
	}
}

const open: { wire: Wire; dir: string }[] = []
afterEach(async () => {
	for (const { wire, dir } of open.splice(0)) {
		wire.child.kill()
		await wire.exited
		rmSync(dir, { recursive: true, force: true })
	}
})

function start(): { wire: Wire; dir: string } {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-terminal-wire-')))
	mkdirSync(join(dir, 'home'))
	const child = spawn(process.execPath, [BIN, 'acp', '--desktop'], {
		cwd: dir,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, NAMZU_HOME: join(dir, 'home'), NAMZU_MODEL_CATALOGUE_REFRESH: '0' },
	})
	const entry = { wire: new Wire(child), dir }
	open.push(entry)
	return entry
}

describe.skipIf(!existsSync(BIN) || !binding || process.platform === 'win32')(
	'namzu acp --desktop hosts terminals',
	() => {
		it('advertises the terminal methods and carries a session end to end', async () => {
			const { wire, dir } = start()
			const init = await wire.request('initialize', {
				protocolVersion: 1,
				capabilities: ['permission'],
			})
			for (const method of Object.values(TERMINAL_METHODS))
				expect(init.extensions).toContain(method)
			expect((await wire.request(TERMINAL_METHODS.status)).available).toBe(true)

			const { terminal } = await wire.request(TERMINAL_METHODS.create, {
				command: '/bin/sh',
				env: { PS1: 'wire> ', ELECTRON_RUN_AS_NODE: null },
				cols: 90,
				rows: 20,
			})
			expect(terminal.cwd).toBe(dir)
			const attached = await wire.request(TERMINAL_METHODS.attach, {
				terminalId: terminal.id,
				viewerId: 'test',
				writer: true,
			})
			expect(attached).toMatchObject({ mode: 'snapshot', writer: true })
			let seen = attached.data as string
			const text = () => {
				for (const frame of wire.notifications(TERMINAL_NOTIFICATIONS.data)) {
					const { offset, data } = frame.params as { offset: number; data: string }
					if (offset === seen.length + (attached.start as number)) seen += data
				}
				return seen
			}
			await wire.until(() => (text().includes('wire> ') ? true : undefined))
			await wire.request(TERMINAL_METHODS.write, {
				terminalId: terminal.id,
				viewerId: 'test',
				data: 'echo got-$((6*7)) && stty size\r',
			})
			await wire.until(() =>
				text().includes('got-42') && text().includes('20 90') ? true : undefined,
			)
			await wire.request(TERMINAL_METHODS.ack, {
				terminalId: terminal.id,
				offset: (attached.start as number) + seen.length,
			})

			// A second view, late, sees the same screen without replaying the stream.
			const late = await wire.request(TERMINAL_METHODS.attach, {
				terminalId: terminal.id,
				viewerId: 'late',
			})
			expect(late.mode).toBe('snapshot')
			expect(late.screen).toContain('got-42')
			await expect(
				wire.request(TERMINAL_METHODS.write, {
					terminalId: terminal.id,
					viewerId: 'late',
					data: 'x',
				}),
			).rejects.toThrow(/keyboard/)

			await wire.request(TERMINAL_METHODS.kill, { terminalId: terminal.id })
			const exit = await wire.until(() => wire.notifications(TERMINAL_NOTIFICATIONS.exit)[0])
			expect(exit.params).toMatchObject({ terminalId: terminal.id })
			expect((await wire.request(TERMINAL_METHODS.list)).terminals[0].status).toBe('exited')

			// The protocol stream carried nothing but frames.
			expect(wire.garbage).toEqual([])
		}, 30_000)

		it('ends its terminals when the desktop closes the connection', async () => {
			const { wire } = start()
			await wire.request('initialize', { protocolVersion: 1, capabilities: ['permission'] })
			const { terminal } = await wire.request(TERMINAL_METHODS.create, {
				command: '/bin/sh',
				cols: 80,
				rows: 24,
			})
			const pid = terminal.pid as number
			expect(pid).toBeGreaterThan(0)
			wire.child.stdin.end()
			expect(await wire.exited).toBe(0)
			// The host waited for the terminal to end before it exited.
			expect(() => process.kill(pid, 0)).toThrow()
		}, 30_000)
	},
)
