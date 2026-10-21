import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import type { WebSocket as ServerSocket } from 'ws'

import { expiryNotice } from '../monitor-stream.js'
import {
	type BackgroundJob,
	BackgroundJobRegistry,
	type MonitorEvent,
	bindOwner,
	describeMonitorEnd,
} from '../registry.js'

/**
 * A WebSocket as a monitor's source, against a real server on this machine.
 *
 * The registry's half of the contract is the same as for a command (batches,
 * rationing, expiry, stop), so what is checked here is that a connection feeds
 * it the way a process does: frames become lines, the lifecycle notices arrive
 * as notices and end the stream, and every way of stopping closes the socket
 * and leaves nothing after the notice that said why.
 *
 * Only `setTimeout`, `clearTimeout` and `Date` are faked: the sockets are real,
 * so each step waits for the bytes it sent to arrive (`seen`) and then moves
 * the 200 ms window or the deadline by calling a function, never by waiting.
 */

const LOOPBACK = [{ address: '127.0.0.1', family: 4 as const }]

interface Fixture {
	readonly server: WebSocketServer
	readonly url: string
	/** The next connection the server accepts. */
	next(): Promise<ServerSocket>
	/** The close code each accepted connection ended with. */
	readonly closes: Promise<number>[]
}

const servers: WebSocketServer[] = []

async function fixture(options: { reject?: number } = {}): Promise<Fixture> {
	const server = new WebSocketServer({
		host: '127.0.0.1',
		port: 0,
		...(options.reject !== undefined
			? { verifyClient: (_info, done) => done(false, options.reject, 'no') }
			: {}),
	})
	servers.push(server)
	await new Promise<void>((resolve) => server.once('listening', resolve))
	const port = (server.address() as AddressInfo).port
	const waiting: ((socket: ServerSocket) => void)[] = []
	const arrived: ServerSocket[] = []
	const closes: Promise<number>[] = []
	server.on('connection', (socket) => {
		closes.push(new Promise((resolve) => socket.once('close', (code) => resolve(code))))
		const waiter = waiting.shift()
		if (waiter) waiter(socket)
		else arrived.push(socket)
	})
	return {
		server,
		url: `ws://127.0.0.1:${port}/feed`,
		closes,
		next: () => {
			const early = arrived.shift()
			if (early) return Promise.resolve(early)
			return new Promise((resolve) => waiting.push(resolve))
		},
	}
}

function setup() {
	const registry = new BackgroundJobRegistry()
	const bound = bindOwner(registry, 'turn-1')
	const events: MonitorEvent[] = []
	const log: string[] = []
	registry.onMonitorEvent((event) => {
		events.push(event)
		log.push(`${event.kind}:${event.text}`)
	})
	registry.onExit((job) => log.push(`exit:${job.status}`))
	// The exit itself, not `waitForExit`: that resolves at once for a job whose
	// stop was already requested, before its process has finished ending.
	const exits = new Map<string, Promise<BackgroundJob>>()
	const start = (url: string, overrides: { timeoutMs?: number } = {}): BackgroundJob => {
		const job = bound.startMonitor({
			description: 'the feed',
			timeoutMs: overrides.timeoutMs ?? 300_000,
			webSocket: { url, addresses: LOOPBACK },
		}).job as BackgroundJob
		exits.set(
			job.id,
			new Promise((resolve) => {
				registry.onExit((ended) => {
					if (ended.id === job.id) resolve(ended)
				})
			}),
		)
		return job
	}
	const exit = (id: string): Promise<BackgroundJob> => exits.get(id) as Promise<BackgroundJob>
	/** Resolves once `literal` has been written after `from`: the bytes are in, so the window can move. */
	const seen = async (id: string, literal: string, from: number): Promise<void> => {
		const result = await registry.waitForOutput(id, {
			literal,
			fromOffset: from,
			// The longest the registry allows. It never decides anything here: the
			// frame arrives from a socket on this machine, and a genuine hang is
			// caught by the test's own timeout.
			timeoutMs: 3_600_000,
		})
		expect(result.kind).toBe('matched')
	}
	const offset = (id: string): number => registry.read(id).nextOffset
	return { registry, bound, events, log, start, exit, seen, offset }
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})
afterEach(async () => {
	vi.useRealTimers()
	for (const server of servers.splice(0)) {
		for (const client of server.clients) client.terminate()
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}
})

describe('a WebSocket monitor turns frames into events', () => {
	it('delivers each text frame’s lines, and frames within one window arrive together', async () => {
		const { registry, events, start, seen, offset } = setup()
		const f = await fixture()
		const job = start(f.url)
		const socket = await f.next()
		const from = offset(job.id)

		socket.send('alpha\nbeta')
		socket.send('gamma\n')
		await seen(job.id, 'gamma', from)
		vi.advanceTimersByTime(200)

		expect(events.map((e) => [e.kind, e.text])).toEqual([['output', 'alpha\nbeta\ngamma']])
		expect(registry.get(job.id).status).toBe('running')
	})

	it('names the job by the URL, query string kept', async () => {
		const { registry, start } = setup()
		const f = await fixture()
		const job = start(`${f.url}?room=ops&token=abc`)
		await f.next()
		expect(registry.get(job.id).command).toBe(`websocket ${f.url}?room=ops&token=abc`)
		expect(registry.get(job.id).transport).toBe('websocket')
	})

	it('counts a binary frame without relaying its bytes', async () => {
		const { events, start, seen, offset } = setup()
		const f = await fixture()
		const job = start(f.url)
		const socket = await f.next()
		const from = offset(job.id)

		socket.send(Buffer.from([1, 2, 3, 4, 5]), { binary: true })
		await seen(job.id, 'bytes]', from)
		vi.advanceTimersByTime(200)

		expect(events.map((e) => e.text)).toEqual(['[binary frame, 5 bytes]'])
	})

	it('connects to the addresses it was given and does not ask DNS for the name', async () => {
		// The name does not resolve anywhere. Reaching the server proves the
		// connection used the vetted address and not a lookup of its own.
		const { events, start, seen, offset, registry } = setup()
		const f = await fixture()
		const port = new URL(f.url).port
		const job = start(`ws://rebinding-guard.invalid:${port}/feed`)
		const socket = await f.next()
		const from = offset(job.id)

		socket.send('hello')
		await seen(job.id, 'hello', from)
		vi.advanceTimersByTime(200)

		expect(events.map((e) => e.text)).toEqual(['hello'])
		expect(registry.get(job.id).status).toBe('running')
	})
})

describe('a WebSocket monitor ends with a notice, and nothing follows it', () => {
	it('says the server closed, after the last lines, and describes the end', async () => {
		const { registry, log, start, exit } = setup()
		const f = await fixture()
		const job = start(f.url)
		const socket = await f.next()

		socket.send('last words')
		socket.close(4000, 'bye now')
		const ended = await exit(job.id)

		expect(log).toEqual([
			'output:last words',
			'notice:[WebSocket closed: 4000 bye now]',
			'exit:exited',
		])
		expect(ended.closeCode).toBe(4000)
		expect(describeMonitorEnd(ended, registry.monitorStats(job.id))).toEqual({
			status: 'failed',
			summary: 'Monitor "the feed" connection closed (4000 bye now)',
		})
	})

	it('treats a normal close as the stream ending', async () => {
		const { registry, start, exit } = setup()
		const f = await fixture()
		const job = start(f.url)
		const socket = await f.next()

		socket.close(1000)
		const ended = await exit(job.id)

		expect(describeMonitorEnd(ended, registry.monitorStats(job.id))).toEqual({
			status: 'completed',
			summary: 'Monitor "the feed" connection closed (1000)',
		})
	})

	it('reports an upgrade the server refused, with its status, and nothing else', async () => {
		const { registry, log, start, exit } = setup()
		const f = await fixture({ reject: 403 })
		const job = start(f.url)
		const ended = await exit(job.id)

		expect(log).toEqual(['notice:[WebSocket upgrade rejected: HTTP 403]', 'exit:exited'])
		expect(describeMonitorEnd(ended, registry.monitorStats(job.id)).summary).toBe(
			'Monitor "the feed" connection failed',
		)
	})

	it('reports a connection that could not be made, then that it closed', async () => {
		const { log, start, exit } = setup()
		const f = await fixture()
		const dead = f.url
		await new Promise<void>((resolve) => f.server.close(() => resolve()))
		const job = start(dead)
		const ended = await exit(job.id)

		expect(log).toHaveLength(3)
		expect(log[0]).toMatch(/^notice:\[WebSocket error: .*ECONNREFUSED.*\]$/)
		expect(log[1]).toBe('notice:[WebSocket closed: 1006]')
		expect(log[2]).toBe('exit:exited')
		expect(ended.exitCode).toBe(1)
	})

	it('closes the connection when a frame is over the limit, and says so', async () => {
		const { log, start, exit } = setup()
		const f = await fixture()
		const job = start(f.url)
		const socket = await f.next()

		socket.send('x'.repeat(1_048_577))
		await exit(job.id)

		expect(log).toEqual([
			'notice:[Dropped a frame larger than 1048576 bytes; closing]',
			'exit:exited',
		])
		expect(await f.closes[0]).toBe(1009)
	})
})

describe('every way of stopping closes the socket and adds nothing after', () => {
	it('stops on a kill with a normal close, and says only that it was stopped', async () => {
		const { registry, bound, events, log, start, seen, offset } = setup()
		const f = await fixture()
		const job = start(f.url)
		const socket = await f.next()
		// The client has finished opening once it has read a frame; closing a
		// socket still connecting is an abort, not the polite close under test.
		const from = offset(job.id)
		socket.send('ready')
		await seen(job.id, 'ready', from)
		vi.advanceTimersByTime(200)

		const ended = await bound.kill(job.id)

		expect(await f.closes[0]).toBe(1000)
		expect(ended.status).toBe('killed')
		expect(ended.stopReason).toBe('stopped')
		// Nothing after the kill: no close notice, no expiry, only the exit.
		expect(log).toEqual(['output:ready', 'exit:killed'])
		expect(events).toHaveLength(1)
		expect(describeMonitorEnd(ended, registry.monitorStats(job.id)).summary).toBe(
			'Monitor "the feed" stopped',
		)
	})

	it('stops at the deadline: the last lines, the expiry notice, a normal close', async () => {
		const { registry, log, start, exit, seen, offset } = setup()
		const f = await fixture()
		const job = start(f.url, { timeoutMs: 5000 })
		const socket = await f.next()
		const from = offset(job.id)

		socket.send('before the end')
		await seen(job.id, 'before the end', from)
		vi.advanceTimersByTime(5000)
		await exit(job.id)

		expect(log).toEqual(['output:before the end', `notice:${expiryNotice(5000, 1)}`, 'exit:killed'])
		expect(await f.closes[0]).toBe(1000)
		expect(registry.get(job.id).stopReason).toBe('expired')
	})

	it('stops a flood: the too-much-output notice is the last thing said', async () => {
		const { registry, events, log, start, exit, seen, offset } = setup()
		const f = await fixture()
		const job = start(f.url)
		const socket = await f.next()

		// Five batches a second against a bucket that refills one every two:
		// it empties, suppression begins, and thirty simulated seconds later the
		// next dropped batch stops the monitor. Each step moves the simulated
		// clock by one window once the frame's bytes are in.
		for (let i = 0; i < 400 && registry.get(job.id).stopReason === undefined; i++) {
			const from = offset(job.id)
			socket.send(`frame-${i}`)
			await seen(job.id, `frame-${i}`, from)
			vi.advanceTimersByTime(200)
		}
		await exit(job.id)

		const last = events[events.length - 1]
		expect(last?.kind).toBe('notice')
		expect(last?.text).toMatch(/^\[Monitor stopped — too much output/)
		expect(log[log.length - 1]).toBe('exit:killed')
		expect(registry.get(job.id).stopReason).toBe('too_much_output')
		expect(await f.closes[0]).toBe(1000)
	}, 60_000)
})
