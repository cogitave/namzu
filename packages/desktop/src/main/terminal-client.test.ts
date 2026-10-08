import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
	TERMINAL_LIMITS,
	TERMINAL_METHODS,
	TERMINAL_NOTIFICATIONS,
} from '../shared/terminal-protocol.js'
import { TerminalHostClient } from './terminal-client.js'

const ID = '0b1e8a0e-5c1e-4a4b-9c3f-2f1a5d0c7e11'
const info = (over: Record<string, unknown> = {}) => ({
	id: ID,
	pid: 7,
	title: 'sh',
	cwd: '/p',
	command: 'sh',
	args: [],
	cols: 80,
	rows: 24,
	status: 'running',
	createdAt: 1,
	offset: 0,
	writerHeld: false,
	...over,
})
const attached = (over: Record<string, unknown> = {}) => ({
	terminal: info(),
	mode: 'snapshot',
	screen: '',
	data: '',
	start: 0,
	end: 0,
	writer: true,
	truncated: false,
	...over,
})

function setup(answers: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
	const bus = new EventEmitter()
	const calls: { method: string; params: Record<string, unknown> }[] = []
	const transport = {
		request: async (method: string, params: Record<string, unknown> = {}) => {
			calls.push({ method, params })
			const answer = answers[method]
			if (!answer) throw new Error(`unexpected ${method}`)
			return answer(params)
		},
		on: (event: 'frame', listener: (frame: Record<string, unknown>) => void) =>
			bus.on(event, listener),
		off: (event: 'frame', listener: (frame: Record<string, unknown>) => void) =>
			bus.off(event, listener),
	}
	const client = new TerminalHostClient(transport, { ackEvery: 10 })
	const data = (offset: number, text: string) =>
		bus.emit('frame', {
			method: TERMINAL_NOTIFICATIONS.data,
			params: { terminalId: ID, offset, data: text },
		})
	const delivered: { offset: number; data: string }[] = []
	client.on('data', (note) => delivered.push({ offset: note.offset, data: note.data }))
	return { client, bus, calls, data, delivered }
}

describe('TerminalHostClient requests', () => {
	it('validates what it sends and what comes back', async () => {
		const { client, calls } = setup({
			[TERMINAL_METHODS.create]: () => ({ terminal: info() }),
			[TERMINAL_METHODS.list]: () => ({ terminals: [info()] }),
			[TERMINAL_METHODS.status]: () => ({
				available: true,
				platform: 'linux',
				limits: { maxTerminals: 16, maxCols: 500, maxRows: 200, maxWrite: 65536, maxChunk: 16384 },
			}),
		})
		expect((await client.create({ cols: 80, rows: 24, command: 'sh' })).id).toBe(ID)
		expect(calls[0]?.params).toEqual({ cols: 80, rows: 24, command: 'sh' })
		await expect(client.create({ cols: 0, rows: 24 })).rejects.toThrow(/columns/)
		expect(await client.list()).toHaveLength(1)
		expect((await client.status()).available).toBe(true)
		expect(calls.map((call) => call.method)).toEqual([
			TERMINAL_METHODS.create,
			TERMINAL_METHODS.list,
			TERMINAL_METHODS.status,
		])
	})

	it('refuses an answer that is not what was asked for', async () => {
		const other = '1c1e8a0e-5c1e-4a4b-9c3f-2f1a5d0c7e99'
		const { client } = setup({
			[TERMINAL_METHODS.attach]: () => attached({ terminal: info({ id: other }) }),
			[TERMINAL_METHODS.list]: () => ({ terminals: [{ nonsense: true }] }),
		})
		await expect(client.attach(ID, 'v')).rejects.toThrow(/different terminal/)
		await expect(client.list()).rejects.toThrow()
	})

	it('sends input longer than the host accepts in order, whole, without splitting a pair', async () => {
		const written: string[] = []
		const { client } = setup({
			[TERMINAL_METHODS.write]: (params) => {
				written.push(params.data as string)
				return { written: (params.data as string).length }
			},
		})
		const text = `${'a'.repeat(TERMINAL_LIMITS.maxWrite - 1)}😀${'b'.repeat(10)}`
		await client.write(ID, 'v', text)
		expect(written.join('')).toBe(text)
		expect(written.every((piece) => piece.length <= TERMINAL_LIMITS.maxWrite)).toBe(true)
		expect(written[0]?.endsWith('\ud83d')).toBe(false)
	})

	it('rejects a malformed terminal id before sending anything', async () => {
		const { client, calls } = setup()
		await expect(client.kill('nope')).rejects.toThrow(/id/)
		expect(calls).toEqual([])
	})
})

describe('TerminalHostClient output', () => {
	it('delivers chunks in order, drops what it has, cuts overlaps, and reports a gap once', async () => {
		let answer = attached({ start: 5, end: 5 })
		const { client, data, delivered } = setup({ [TERMINAL_METHODS.attach]: () => answer })
		const gaps: unknown[] = []
		client.on('gap', (gap) => gaps.push(gap))
		data(0, 'ignored: not attached yet')
		await client.attach(ID, 'v')
		expect(client.nextOffset(ID)).toBe(5)
		data(5, 'abc')
		data(5, 'abc')
		data(3, 'XXabcdef')
		expect(delivered).toEqual([
			{ offset: 5, data: 'abc' },
			{ offset: 8, data: 'def' },
		])
		data(20, 'zzz')
		data(23, 'yyy')
		expect(gaps).toEqual([{ terminalId: ID, expected: 11, received: 20 }])
		expect(client.nextOffset(ID)).toBe(11)
		// Re-attaching from the offset the view has clears the gap, and delivery resumes there.
		answer = attached({ mode: 'replay', start: 11, end: 26, data: 'x'.repeat(15) })
		await client.attach(ID, 'v', { fromOffset: 11 })
		expect(client.nextOffset(ID)).toBe(26)
		data(26, 'next')
		expect(delivered.at(-1)).toEqual({ offset: 26, data: 'next' })
		data(99, 'again')
		expect(gaps).toHaveLength(2)
	})

	it('keeps output that arrives in the same read as the answer to an attach', async () => {
		// The answer and the chunk after it come out of one read of the connection, so the chunk is
		// handled before the code waiting on the answer has run.
		let emit: (offset: number, text: string) => void = () => undefined
		const { client, data, delivered } = setup({
			[TERMINAL_METHODS.attach]: () => {
				emit(7, 'after')
				emit(2, 'ab')
				return attached({ mode: 'replay', start: 0, end: 7, data: 'earlier' })
			},
		})
		emit = data
		const result = await client.attach(ID, 'v', { fromOffset: 0 })
		expect(result.end).toBe(7)
		expect(delivered).toEqual([{ offset: 7, data: 'after' }])
		data(12, '!')
		expect(delivered.at(-1)).toEqual({ offset: 12, data: '!' })
	})

	it('does not hold output once an attach has failed', async () => {
		const { client, data, delivered } = setup({
			[TERMINAL_METHODS.attach]: () => {
				throw new Error('refused')
			},
		})
		await expect(client.attach(ID, 'v')).rejects.toThrow('refused')
		data(0, 'x')
		expect(delivered).toEqual([])
		expect(client.nextOffset(ID)).toBeUndefined()
	})

	it('acknowledges in batches, with the offset it reached', async () => {
		const acks: Record<string, unknown>[] = []
		const { client, data } = setup({
			[TERMINAL_METHODS.attach]: () => attached(),
			[TERMINAL_METHODS.ack]: (params) => {
				acks.push(params)
				return {}
			},
		})
		await client.attach(ID, 'v')
		data(0, '12345')
		expect(acks).toEqual([])
		data(5, '67890')
		expect(acks).toEqual([{ terminalId: ID, offset: 10 }])
	})

	it('ignores notifications that fail validation and keeps working', async () => {
		const { client, bus, delivered, data } = setup({ [TERMINAL_METHODS.attach]: () => attached() })
		await client.attach(ID, 'v')
		bus.emit('frame', {
			method: TERMINAL_NOTIFICATIONS.data,
			params: { terminalId: ID, offset: 0 },
		})
		bus.emit('frame', {
			method: TERMINAL_NOTIFICATIONS.data,
			params: { terminalId: 'x', offset: 0, data: 'a' },
		})
		bus.emit('frame', { method: 'session/update', params: {} })
		data(0, 'ok')
		expect(delivered).toEqual([{ offset: 0, data: 'ok' }])
	})

	it('reports an exit and stops listening when disposed', async () => {
		const { client, bus, data, delivered } = setup({ [TERMINAL_METHODS.attach]: () => attached() })
		const exits: unknown[] = []
		client.on('exit', (note) => exits.push(note))
		await client.attach(ID, 'v')
		bus.emit('frame', {
			method: TERMINAL_NOTIFICATIONS.exit,
			params: { terminalId: ID, exitCode: 2, signal: 9 },
		})
		expect(exits).toEqual([{ terminalId: ID, exitCode: 2, signal: 9 }])
		client.dispose()
		data(0, 'late')
		expect(delivered).toEqual([])
	})
})
