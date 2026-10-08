import { describe, expect, it } from 'vitest'
import { createTerminalHost } from '../host.js'
import { TERMINAL_METHODS, TERMINAL_NOTIFICATIONS } from '../protocol.js'
import { fakeBinding, manualDefer } from './support/fake-pty.js'

function setup(load?: () => Promise<never>) {
	const { binding, spawned } = fakeBinding()
	const flush = manualDefer()
	const sent: { method: string; params: Record<string, unknown> }[] = []
	const host = createTerminalHost({
		cwd: process.cwd(),
		platform: 'linux',
		env: { PATH: '/bin' },
		defer: flush.defer,
		loadPty: load ?? (async () => binding),
		notify: (method, params) => sent.push({ method, params }),
	})
	const call = (method: string, params: Record<string, unknown> = {}) => {
		const handler = host.extensions[method]
		if (!handler) throw new Error(`no ${method}`)
		return Promise.resolve().then(() => handler(params)) as Promise<Record<string, any>>
	}
	return { host, spawned, flush, sent, call }
}

describe('terminal host extensions', () => {
	it('registers exactly the documented methods', () => {
		const { host } = setup()
		expect(Object.keys(host.extensions).sort()).toEqual(Object.values(TERMINAL_METHODS).sort())
	})

	it('reports availability and the reason when the binding is missing', async () => {
		const ok = await setup().call(TERMINAL_METHODS.status)
		expect(ok).toMatchObject({ available: true, platform: 'linux' })
		const missing = setup(async () => {
			throw new Error("Cannot find module 'node-pty'")
		})
		const status = await missing.call(TERMINAL_METHODS.status)
		expect(status.available).toBe(false)
		expect(status.reason).toMatch(/not installed/)
		await expect(missing.call(TERMINAL_METHODS.create, { cols: 80, rows: 24 })).rejects.toThrow(
			/not installed/,
		)
	})

	it('walks a terminal from creation to its end over the wire shapes', async () => {
		const { call, spawned, flush, sent } = setup()
		const { terminal } = await call(TERMINAL_METHODS.create, {
			cols: 80,
			rows: 24,
			command: 'sh',
			args: ['-i'],
		})
		expect(terminal).toMatchObject({ status: 'running', command: 'sh', args: ['-i'] })
		const attached = await call(TERMINAL_METHODS.attach, {
			terminalId: terminal.id,
			viewerId: 'main',
			writer: true,
		})
		expect(attached).toMatchObject({ mode: 'snapshot', start: 0, end: 0, writer: true })
		expect(
			await call(TERMINAL_METHODS.write, {
				terminalId: terminal.id,
				viewerId: 'main',
				data: 'ls\r',
			}),
		).toEqual({
			written: 3,
		})
		expect(spawned[0]?.writes).toEqual(['ls\r'])
		spawned[0]?.print('file\r\n')
		flush.run()
		expect(sent).toEqual([
			{
				method: TERMINAL_NOTIFICATIONS.data,
				params: { terminalId: terminal.id, offset: 0, data: 'file\r\n' },
			},
		])
		await call(TERMINAL_METHODS.ack, { terminalId: terminal.id, offset: 6 })
		await call(TERMINAL_METHODS.resize, {
			terminalId: terminal.id,
			viewerId: 'main',
			cols: 90,
			rows: 30,
		})
		expect((await call(TERMINAL_METHODS.list)).terminals[0]).toMatchObject({
			cols: 90,
			rows: 30,
			offset: 6,
		})
		const killed = call(TERMINAL_METHODS.kill, { terminalId: terminal.id })
		await Promise.resolve()
		spawned[0]?.end(0, 1)
		await killed
		expect(sent.at(-1)).toEqual({
			method: TERMINAL_NOTIFICATIONS.exit,
			params: { terminalId: terminal.id, exitCode: 0, signal: 1 },
		})
		await call(TERMINAL_METHODS.close, { terminalId: terminal.id })
		expect((await call(TERMINAL_METHODS.list)).terminals).toEqual([])
	})

	it('rejects malformed requests before touching a terminal', async () => {
		const { call, spawned } = setup()
		await expect(call(TERMINAL_METHODS.create, { cols: 0, rows: 24 })).rejects.toThrow(/cols/)
		await expect(call(TERMINAL_METHODS.write, { terminalId: 'x' })).rejects.toThrow(/terminalId/)
		await expect(call(TERMINAL_METHODS.list, { extra: 1 })).rejects.toThrow()
		expect(spawned).toEqual([])
	})

	it('survives a notify that throws', async () => {
		const { binding, spawned } = fakeBinding()
		const flush = manualDefer()
		const host = createTerminalHost({
			cwd: process.cwd(),
			platform: 'linux',
			defer: flush.defer,
			loadPty: async () => binding,
			notify: () => {
				throw new Error('stdout closed')
			},
		})
		const { terminal } = (await host.extensions[TERMINAL_METHODS.create]?.({
			cols: 80,
			rows: 24,
		})) as { terminal: { id: string } }
		await host.extensions[TERMINAL_METHODS.attach]?.({ terminalId: terminal.id, viewerId: 'a' })
		spawned[0]?.print('x')
		expect(() => flush.run()).not.toThrow()
	})

	it('close ends every terminal', async () => {
		const { host, call, spawned } = setup()
		await call(TERMINAL_METHODS.create, { cols: 80, rows: 24 })
		const closing = host.close()
		spawned[0]?.end(0, 1)
		await closing
		expect(host.manager.list()).toEqual([])
	})
})
