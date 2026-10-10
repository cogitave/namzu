import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { type TerminalEvent, TerminalManager } from '../manager.js'
import { loadHostPty } from '../pty.js'

/**
 * A real pseudo-terminal, a real shell, no clock: every wait below is on the output
 * or the exit the program itself produces, so the test is as fast as the machine and
 * a genuine hang is caught by the runner's own limit.
 */
let binding: Awaited<ReturnType<typeof loadHostPty>> | undefined
try {
	binding = await loadHostPty()
} catch {
	binding = undefined
}

describe.skipIf(!binding || process.platform === 'win32')('a real pseudo-terminal', () => {
	function open() {
		const events: TerminalEvent[] = []
		const waiting: (() => void)[] = []
		const manager = new TerminalManager({
			loadPty: async () => binding as NonNullable<typeof binding>,
			emit: (event) => {
				events.push(event)
				for (const wake of waiting.splice(0)) wake()
			},
			cwd: process.cwd(),
		})
		const printed = () =>
			events.map((event) => (event.type === 'data' ? event.params.data : '')).join('')
		const until = async (done: () => boolean) => {
			while (!done()) await new Promise<void>((resolve) => waiting.push(resolve))
		}
		return { manager, events, printed, until }
	}

	it('runs a command, reports its size, follows a resize, and ends with the tree', async () => {
		const { manager, printed, until } = open()
		const info = await manager.create({
			command: '/bin/sh',
			args: [],
			env: { PS1: 'ready> ' },
			cols: 80,
			rows: 24,
		})
		manager.attach({ terminalId: info.id, viewerId: 'v', writer: true, force: false })
		await until(() => printed().includes('ready> '))
		manager.write({ terminalId: info.id, viewerId: 'v', data: 'echo $((6*7)) && stty size\r' })
		await until(() => printed().includes('24 80'))
		expect(printed()).toContain('42')
		manager.resize({ terminalId: info.id, viewerId: 'v', cols: 100, rows: 30 })
		manager.write({ terminalId: info.id, viewerId: 'v', data: 'stty size\r' })
		await until(() => printed().includes('30 100'))
		await manager.screenSettled(info.id)
		expect(manager.screenLines(info.id).join('\n')).toContain('30 100')
		await manager.kill(info.id)
		expect(manager.list()[0]?.status).toBe('exited')
		await manager.closeAll()
	})

	it('a late view reconstructs the screen from a snapshot and the data after it', async () => {
		const { manager, printed, until } = open()
		const info = await manager.create({
			command: '/bin/sh',
			args: [],
			env: { PS1: '$ ' },
			cols: 60,
			rows: 10,
		})
		manager.attach({ terminalId: info.id, viewerId: 'first', writer: true, force: false })
		await until(() => printed().includes('$ '))
		manager.write({ terminalId: info.id, viewerId: 'first', data: 'echo marker-one\r' })
		await until(() => printed().includes('marker-one\r\n'))
		await manager.screenSettled(info.id)
		const late = manager.attach({
			terminalId: info.id,
			viewerId: 'late',
			writer: false,
			force: false,
		})
		expect(late.mode).toBe('snapshot')
		expect(late.screen).toContain('marker-one')
		expect(late.end).toBe(info.offset + printed().length)
		await manager.closeAll()
	})

	it('closing a terminal also ends a program that detached itself from the shell', async () => {
		const { manager, printed, until } = open()
		const info = await manager.create({
			command: '/bin/sh',
			args: [],
			env: { PS1: 'ready> ' },
			cols: 80,
			rows: 24,
		})
		manager.attach({ terminalId: info.id, viewerId: 'v', writer: true, force: false })
		await until(() => printed().includes('ready> '))
		manager.write({
			terminalId: info.id,
			viewerId: 'v',
			// The detached program prints its own pid and becomes `sleep` under it: `$!` would name
			// `setsid`, which forks and exits at once when it leads its job's process group.
			data: 'setsid sh -c \'echo "detached=$$"; exec sleep 300 < /dev/null > /dev/null 2>&1\' &\r',
		})
		let pid = Number.NaN
		let finished = false
		try {
			await until(() => /detached=\d+\r?\n/u.test(printed()))
			pid = Number(/detached=(\d+)/u.exec(printed())?.[1])
			const alive = () => {
				try {
					process.kill(pid, 0)
					return true
				} catch {
					return false
				}
			}
			expect(alive()).toBe(true)
			await manager.close(info.id)
			// SIGKILL is sent by the time close returns, but the kernel ends the program only once it
			// is next scheduled, which on a loaded machine is later. Wait for the end itself (gone, or
			// a zombie waiting to be reaped); a program that never ends is caught by the runner's limit.
			const ended = async () => {
				const state = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => 'gone')
				return state === 'gone' || state.includes(') Z ')
			}
			while (!(await ended())) await new Promise((resolve) => setTimeout(resolve, 10))
			expect(await ended()).toBe(true)
			finished = true
		} finally {
			// A failed expectation must not leave the program running for five minutes.
			if (!finished && Number.isInteger(pid)) {
				try {
					process.kill(pid, 'SIGKILL')
				} catch {
					/* Already gone, as intended. */
				}
			}
		}
	})

	it('reports a program that cannot start', async () => {
		const { manager, until, events } = open()
		const info = await manager
			.create({
				command: '/definitely/not/here',
				args: [],
				env: {},
				cols: 80,
				rows: 24,
			})
			.catch((error: Error) => error)
		if (info instanceof Error) {
			expect(info.message).toMatch(/Could not start/)
		} else {
			await until(() => events.some((event) => event.type === 'exit'))
			expect(events.at(-1)).toMatchObject({ type: 'exit' })
			expect((events.at(-1) as { params: { exitCode: number } }).params.exitCode).not.toBe(0)
		}
		await manager.closeAll()
	})
})
