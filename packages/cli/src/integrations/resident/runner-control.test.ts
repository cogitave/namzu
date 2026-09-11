import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { type Socket, createConnection, createServer } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	type RunnerControlRecord,
	type RunnerControlServer,
	type RunnerControlStatus,
	createRunnerControlServer,
	queryRunner,
} from './runner-control.js'

const controls: RunnerControlServer[] = []
const sockets = new Set<Socket>()
const extraServers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
	for (const socket of sockets) socket.destroy()
	sockets.clear()
	await Promise.all(controls.splice(0).map((control) => control.close()))
	await Promise.all(
		extraServers
			.splice(0)
			.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	)
})

function track(socket: Socket): Socket {
	sockets.add(socket)
	socket.on('error', () => {})
	socket.once('close', () => sockets.delete(socket))
	return socket
}

async function fixture() {
	const state: { value: RunnerControlStatus } = {
		value: { pid: process.pid, phase: 'idle', stepsStarted: 0 },
	}
	const identity = { instanceId: randomUUID(), token: randomBytes(32).toString('hex') }
	const getStatus = vi.fn(() => state.value)
	const onStop = vi.fn()
	const control = await createRunnerControlServer({ ...identity, getStatus, onStop })
	controls.push(control)
	const record: RunnerControlRecord = { ...identity, port: control.port, pid: process.pid }
	return { state, getStatus, onStop, control, record }
}

function request(record: RunnerControlRecord, override: Record<string, unknown> = {}): string {
	return `${JSON.stringify({ version: 1, instanceId: record.instanceId, token: record.token, action: 'status', ...override })}\n`
}

async function rawRequest(port: number, body: string): Promise<string> {
	const socket = track(createConnection({ host: '127.0.0.1', port }))
	let output = ''
	socket.on('data', (chunk) => {
		output += chunk.toString()
	})
	const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
	socket.once('connect', () => socket.write(body))
	await closed
	return output
}

async function responder(response: (socket: Socket) => void): Promise<RunnerControlRecord> {
	const server = createServer((socket) => {
		track(socket)
		socket.once('data', () => response(socket))
	})
	extraServers.push(server)
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const address = server.address()
	if (address === null || typeof address === 'string') throw new Error('Missing test port')
	return {
		port: address.port,
		pid: process.pid,
		instanceId: randomUUID(),
		token: randomBytes(32).toString('hex'),
	}
}

describe('runner control identity and operations', () => {
	it('reports current state without changing the runner', async () => {
		const f = await fixture()
		expect(await queryRunner(f.record, 'status')).toEqual({
			kind: 'responsive',
			instanceId: f.record.instanceId,
			pid: process.pid,
			phase: 'idle',
			stepsStarted: 0,
			stopRequested: false,
		})
		f.state.value = { pid: process.pid, phase: 'working', stepsStarted: 2 }
		expect(await queryRunner(f.record, 'status')).toMatchObject({
			phase: 'working',
			stepsStarted: 2,
		})
		expect(f.onStop).not.toHaveBeenCalled()
	})

	it('acknowledges a stop request once while the worker may still be draining', async () => {
		const f = await fixture()
		f.state.value = { pid: process.pid, phase: 'working', stepsStarted: 1 }
		const results = await Promise.all(
			Array.from({ length: 4 }, () => queryRunner(f.record, 'stop')),
		)
		for (const result of results)
			expect(result).toMatchObject({
				kind: 'responsive',
				phase: 'stopping',
				stopRequested: true,
				stepsStarted: 1,
			})
		expect(f.onStop).toHaveBeenCalledOnce()
		expect(await queryRunner(f.record, 'status')).toMatchObject({
			phase: 'stopping',
			stopRequested: true,
		})
		expect(results.every((result) => !('drained' in result))).toBe(true)
	})

	it.each([
		{ version: 2 },
		{ instanceId: 'other-runner' },
		{ token: 'wrong' },
		{ action: 'execute' },
		{ command: 'unexpected' },
		{ token: null },
	])(
		'refuses invalid or unauthenticated requests without invoking callbacks (%#)',
		async (override) => {
			const f = await fixture()
			expect(await rawRequest(f.control.port, request(f.record, override))).toBe('')
			expect(f.getStatus).not.toHaveBeenCalled()
			expect(f.onStop).not.toHaveBeenCalled()
		},
	)

	it('refuses a same-length wrong token and never returns the secret', async () => {
		const f = await fixture()
		const wrong = {
			...f.record,
			token:
				f.record.token[0] === '0' ? `1${f.record.token.slice(1)}` : `0${f.record.token.slice(1)}`,
		}
		expect(await queryRunner(wrong, 'stop')).toMatchObject({ kind: 'unresponsive' })
		expect(f.onStop).not.toHaveBeenCalled()
		const answer = await rawRequest(f.control.port, request(f.record))
		expect(answer).not.toContain(f.record.token)
		expect(JSON.parse(answer)).toMatchObject({ instanceId: f.record.instanceId, phase: 'idle' })
	})

	it('handles callback failure as an unresponsive endpoint without leaking error data', async () => {
		const f = await fixture()
		f.getStatus.mockImplementation(() => {
			throw new Error(`private ${f.record.token}`)
		})
		const answer = await queryRunner(f.record, 'status')
		expect(answer).toMatchObject({ kind: 'unresponsive' })
		expect(JSON.stringify(answer)).not.toContain(f.record.token)
	})

	it('does not later acknowledge a stop callback that failed', async () => {
		const f = await fixture()
		f.onStop.mockImplementation(() => {
			throw new Error(`private ${f.record.token}`)
		})
		for (const action of ['stop', 'stop', 'status'] as const) {
			const answer = await queryRunner(f.record, action)
			expect(answer).toMatchObject({ kind: 'unresponsive' })
			expect(JSON.stringify(answer)).not.toContain(f.record.token)
		}
		expect(f.onStop).toHaveBeenCalledOnce()
	})
})

describe('bounded input, sockets and teardown', () => {
	it.each(['not json\n', 'null\n', '[]\n', 'x'.repeat(4_097), 'ü'.repeat(2_050)])(
		'closes malformed or oversized input (%#)',
		async (body) => {
			const f = await fixture()
			expect(await rawRequest(f.control.port, body)).toBe('')
			expect(f.getStatus).not.toHaveBeenCalled()
		},
	)

	it('accepts a single fragmented request and refuses a pipelined second frame', async () => {
		const f = await fixture()
		const socket = track(createConnection({ host: '127.0.0.1', port: f.control.port }))
		await once(socket, 'connect')
		const payload = request(f.record)
		socket.write(payload.slice(0, 20))
		const response = once(socket, 'data')
		socket.write(payload.slice(20))
		expect(JSON.parse((await response)[0].toString())).toMatchObject({
			instanceId: f.record.instanceId,
		})
		f.getStatus.mockClear()
		expect(
			await rawRequest(f.control.port, request(f.record) + request(f.record, { action: 'stop' })),
		).toBe('')
		expect(f.getStatus).not.toHaveBeenCalled()
		expect(f.onStop).not.toHaveBeenCalled()
	})

	it('a slow sender cannot extend the total request deadline', async () => {
		const f = await fixture()
		const socket = track(createConnection({ host: '127.0.0.1', port: f.control.port }))
		const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
		await once(socket, 'connect')
		const started = Date.now()
		const sender = setInterval(() => socket.write(' '), 40)
		try {
			await closed
		} finally {
			clearInterval(sender)
		}
		expect(Date.now() - started).toBeLessThan(3_000)
		expect(f.getStatus).not.toHaveBeenCalled()
	})

	it('bounds open sockets and close releases clients that never finish a request', async () => {
		const f = await fixture()
		const waiting = Array.from({ length: 16 }, () =>
			track(createConnection({ host: '127.0.0.1', port: f.control.port })),
		)
		await Promise.all(waiting.map((socket) => once(socket, 'connect')))
		await new Promise<void>((resolve) => setImmediate(resolve))
		const excess = await queryRunner(f.record, 'status', { timeoutMs: 500 })
		expect(excess).toMatchObject({ kind: 'unresponsive' })
		expect(f.getStatus).not.toHaveBeenCalled()
		const closed = waiting.map(
			(socket) => new Promise<void>((resolve) => socket.once('close', () => resolve())),
		)
		const close = f.control.close()
		expect(f.control.close()).toBe(close)
		await close
		await Promise.all(closed)
		expect(waiting.every((socket) => socket.destroyed)).toBe(true)
		expect(await queryRunner(f.record, 'status')).toMatchObject({ kind: 'unresponsive' })
	})
})

describe('client response validation', () => {
	it('reports unavailable and unresponsive endpoints without declaring process death', async () => {
		const f = await fixture()
		expect(await queryRunner({ ...f.record, port: null, pid: null }, 'status')).toEqual({
			kind: 'unresponsive',
			reason: 'Runner control endpoint is unavailable.',
		})
		await f.control.close()
		const result = await queryRunner(f.record, 'stop')
		expect(result).toMatchObject({ kind: 'unresponsive' })
		expect(result).not.toHaveProperty('dead')
	})

	it('times out a connected endpoint that never answers', async () => {
		const record = await responder(() => {})
		expect(await queryRunner(record, 'status', { timeoutMs: 40 })).toEqual({
			kind: 'unresponsive',
			reason: 'Runner control response timed out.',
		})
	})

	it.each([
		{ version: 2 },
		{ instanceId: 'different-runner' },
		{ pid: process.pid + 1 },
		{ phase: 'dead' },
		{ stepsStarted: -1 },
		{ stepsStarted: 0.5 },
		{ stopRequested: 'yes' },
		{ stopRequested: true, phase: 'idle' },
		{ extra: 'unsupported' },
	])('refuses a foreign or malformed response (%#)', async (override) => {
		const record = await responder((socket) =>
			socket.end(
				`${JSON.stringify({ version: 1, instanceId: record.instanceId, pid: record.pid, phase: 'idle', stepsStarted: 0, stopRequested: false, ...override })}\n`,
			),
		)
		expect(await queryRunner(record, 'status')).toEqual({
			kind: 'unresponsive',
			reason: 'Runner control returned an invalid response.',
		})
	})

	it.each(['not-json\n', ' '.repeat(4_097), '{}\n{}\n'])(
		'bounds and validates response framing (%#)',
		async (body) => {
			const record = await responder((socket) => socket.end(body))
			expect(await queryRunner(record, 'status')).toMatchObject({ kind: 'unresponsive' })
		},
	)

	it('does not accept a status-only response as acknowledgment of a stop request', async () => {
		const record = await responder((socket) =>
			socket.end(
				`${JSON.stringify({ version: 1, instanceId: record.instanceId, pid: record.pid, phase: 'idle', stepsStarted: 0, stopRequested: false })}\n`,
			),
		)
		expect(await queryRunner(record, 'stop')).toEqual({
			kind: 'unresponsive',
			reason: 'Runner control returned an invalid response.',
		})
	})
})
