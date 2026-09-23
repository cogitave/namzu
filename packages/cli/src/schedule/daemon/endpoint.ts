/**
 * The daemon's control endpoint: loopback TCP on an ephemeral port, one
 * newline-delimited JSON request per connection, authenticated by a 32-byte
 * token kept in `daemon/endpoint.json` (0600). The actions are `status`,
 * `reload`, `run-now`, `stop` and `drain-and-restart` — nothing that carries a
 * prompt or runs a tool.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { type Socket, createConnection, createServer } from 'node:net'
import { writeJsonAtomic } from '../store/atomic.js'

const MAX_MESSAGE = 8_192
const TIMEOUT_MS = 2_000

export type EndpointAction = 'status' | 'reload' | 'run-now' | 'stop' | 'drain-and-restart'

export interface EndpointRecord {
	readonly v: 1
	readonly kind: 'schedule-endpoint'
	readonly port: number
	readonly token: string
	readonly epoch: string
	readonly pid: number
}

export interface EndpointHandlers {
	status(): Record<string, unknown>
	reload(): void
	runNow(jobId: string): { ok: boolean; message: string }
	stop(): void
	drainAndRestart(): void
}

export interface EndpointServer {
	readonly port: number
	close(): Promise<void>
}

/** Start the endpoint and publish `endpoint.json`. */
export async function startEndpoint(
	path: string,
	epoch: string,
	handlers: EndpointHandlers,
): Promise<EndpointServer> {
	const token = randomBytes(32).toString('hex')
	const expected = Buffer.from(token)
	const sockets = new Set<Socket>()
	const server = createServer((socket) => {
		socket.on('error', () => {})
		if (sockets.size >= 16) {
			socket.destroy()
			return
		}
		sockets.add(socket)
		socket.once('close', () => sockets.delete(socket))
		const deadline = setTimeout(() => socket.destroy(), TIMEOUT_MS)
		socket.once('close', () => clearTimeout(deadline))
		let buffered = Buffer.alloc(0)
		socket.on('data', (chunk: Buffer) => {
			if (buffered.length + chunk.length > MAX_MESSAGE) {
				socket.destroy()
				return
			}
			buffered = Buffer.concat([buffered, chunk])
			const newline = buffered.indexOf(10)
			if (newline < 0) return
			try {
				const request = JSON.parse(buffered.subarray(0, newline).toString('utf8')) as {
					token?: unknown
					action?: unknown
					jobId?: unknown
				}
				const presented = Buffer.from(typeof request.token === 'string' ? request.token : '')
				if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
					socket.destroy()
					return
				}
				let response: Record<string, unknown>
				switch (request.action) {
					case 'status':
						response = { ok: true, ...handlers.status() }
						break
					case 'reload':
						handlers.reload()
						response = { ok: true }
						break
					case 'run-now':
						response =
							typeof request.jobId === 'string'
								? handlers.runNow(request.jobId)
								: { ok: false, message: 'run-now needs a jobId' }
						break
					case 'stop':
						handlers.stop()
						response = { ok: true }
						break
					case 'drain-and-restart':
						handlers.drainAndRestart()
						response = { ok: true }
						break
					default:
						socket.destroy()
						return
				}
				socket.end(`${JSON.stringify(response)}\n`)
			} catch {
				socket.destroy()
			}
		})
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
			server.removeListener('error', reject)
			resolve()
		})
	})
	server.on('error', () => {})
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('the endpoint has no port')
	const record: EndpointRecord = {
		v: 1,
		kind: 'schedule-endpoint',
		port: address.port,
		token,
		epoch,
		pid: process.pid,
	}
	writeJsonAtomic(path, record)
	return {
		port: address.port,
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy()
				server.close(() => resolve())
				try {
					const current = JSON.parse(readFileSync(path, 'utf8')) as EndpointRecord
					if (current.epoch === epoch) rmSync(path, { force: true })
				} catch {}
			}),
	}
}

export function readEndpoint(path: string): EndpointRecord | undefined {
	try {
		const record = JSON.parse(readFileSync(path, 'utf8')) as EndpointRecord
		if (record.kind === 'schedule-endpoint' && Number.isSafeInteger(record.port)) return record
	} catch {}
	return undefined
}

/** Ask the daemon something. `undefined` when it does not answer; absence never proves it is gone. */
export function callEndpoint(
	record: EndpointRecord,
	action: EndpointAction,
	extra: { readonly jobId?: string } = {},
	timeoutMs = TIMEOUT_MS,
): Promise<Record<string, unknown> | undefined> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: '127.0.0.1', port: record.port })
		let buffered = Buffer.alloc(0)
		let settled = false
		const done = (value: Record<string, unknown> | undefined) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			socket.destroy()
			resolve(value)
		}
		const timer = setTimeout(() => done(undefined), timeoutMs)
		socket.once('error', () => done(undefined))
		socket.once('close', () => done(undefined))
		socket.once('connect', () => {
			socket.write(`${JSON.stringify({ token: record.token, action, ...extra })}\n`)
		})
		socket.on('data', (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk])
			const newline = buffered.indexOf(10)
			if (newline < 0) return
			try {
				done(JSON.parse(buffered.subarray(0, newline).toString('utf8')) as Record<string, unknown>)
			} catch {
				done(undefined)
			}
		})
	})
}
