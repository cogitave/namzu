/**
 * Mutually authenticated TLS between machines of one network.
 *
 * Both sides present their machine certificate (`x509.ts`), request the
 * other's, and then pin: the SPKI of the certificate the peer actually used is
 * hashed to a machine id and checked against membership. A connection from a
 * key that is not a member may send exactly `ping_net`, `join_request` and `join_cancel`, in
 * a 4 KiB line, within two seconds; anything else closes the socket and is
 * audited. Membership is re-checked on every request, so a removal closes
 * even a long-lived connection.
 *
 * Framing is the `namzu-peer/1` one: newline-delimited JSON, one response per
 * request. Nothing here decides what a request means; the service does.
 *
 * @experimental
 */

import { X509Certificate } from 'node:crypto'
import { type Server, type TLSSocket, connect, createServer } from 'node:tls'
import type { NetworkClock } from './clock.js'
import { type MachineKey, exportMachineKeyPem, machineIdOf } from './identity.js'
import {
	MAX_NET_LINE_BYTES,
	MAX_PREAUTH_LINE_BYTES,
	type NetRequest,
	NetRequestSchema,
	PREAUTH_OPS,
} from './wire.js'

export type NetworkErrorCode =
	| 'unattended'
	| 'off'
	| 'dial'
	| 'timeout'
	| 'not_member'
	| 'bad_frame'
	| 'refused'
	| 'no_network'
	| 'unknown_target'
	| 'invalid'

export class NetworkError extends Error {
	override readonly name = 'NetworkError'
	constructor(
		readonly code: NetworkErrorCode,
		message: string,
	) {
		super(message)
	}
}

/** What a machine presents on TLS: its key and its certificate. */
export interface TlsIdentity {
	readonly key: MachineKey
	readonly certificatePem: string
}

export interface PeerInfo {
	readonly machineId: string
	readonly publicKeyDer: Buffer
}

function peerOf(socket: TLSSocket): PeerInfo | undefined {
	const cert = socket.getPeerCertificate(true)
	if (!cert || !cert.raw) return undefined
	try {
		const publicKeyDer = new X509Certificate(cert.raw).publicKey.export({
			type: 'spki',
			format: 'der',
		})
		return { machineId: machineIdOf(publicKeyDer), publicKeyDer }
	} catch {
		return undefined
	}
}

export const FIRST_LINE_DEADLINE_MS = 2_000
export const IDLE_DEADLINE_MS = 30_000
export const DIAL_DEADLINE_MS = 3_000
export const MAX_UNAUTH_PER_ADDRESS = 4
export const MAX_UNAUTH_TOTAL = 16
export const MAX_AUTH_CONNECTIONS = 32

export interface ServerContext {
	readonly peer: PeerInfo
	/** Whether the peer is a member right now. */
	readonly member: boolean
	readonly sourceAddress: string
	/** Keep the connection open past the deadlines (a pending join); the handler owns closing it. */
	holdOpen(): void
	/** Write a further frame on this connection. */
	write(frame: unknown): void
	onClose(callback: () => void): void
	close(): void
}

export interface RefusedConnection {
	readonly sourceAddress: string
	readonly machineId: string | undefined
	readonly reason:
		| 'not_member'
		| 'oversize'
		| 'bad_frame'
		| 'too_many'
		| 'no_certificate'
		| 'deadline'
	readonly op?: string
}

export interface NetListenerOptions {
	readonly identity: TlsIdentity
	readonly clock: NetworkClock
	readonly isMember: (machineId: string) => boolean
	readonly handle: (request: NetRequest, context: ServerContext) => Promise<unknown>
	readonly onRefused?: (info: RefusedConnection) => void
}

export interface NetListener {
	/** Bind and return the port actually bound. */
	listen(host: string, port: number): Promise<number>
	/** Close every open connection of one machine (it was removed). */
	closeMachine(machineId: string): void
	close(): Promise<void>
	readonly connections: number
}

function lines(onLine: (line: string) => void, onOversize: () => void, limit: () => number) {
	let buffer = ''
	return (chunk: Buffer) => {
		buffer += chunk.toString('utf8')
		for (;;) {
			const at = buffer.indexOf('\n')
			if (at < 0) break
			const line = buffer.slice(0, at)
			buffer = buffer.slice(at + 1)
			if (Buffer.byteLength(line, 'utf8') > limit()) return onOversize()
			if (line.trim().length > 0) onLine(line)
		}
		if (Buffer.byteLength(buffer, 'utf8') > limit()) onOversize()
	}
}

export function createNetListener(options: NetListenerOptions): NetListener {
	const sockets = new Set<TLSSocket>()
	const byMachine = new Map<string, Set<TLSSocket>>()
	const unauthByAddress = new Map<string, number>()
	let unauthTotal = 0
	let authTotal = 0
	const servers: Server[] = []

	const track = (server: Server) => {
		server.on('secureConnection', (socket: TLSSocket) => {
			const sourceAddress = socket.remoteAddress ?? 'unknown'
			sockets.add(socket)
			socket.on('error', () => socket.destroy())
			const peer = peerOf(socket)
			const refuse = (reason: RefusedConnection['reason'], op?: string) => {
				options.onRefused?.({ sourceAddress, machineId: peer?.machineId, reason, op })
				socket.destroy()
			}
			if (!peer) return refuse('no_certificate')

			let counted: 'auth' | 'unauth' | undefined
			let held = false
			let cancelDeadline: (() => void) | undefined
			const closers: Array<() => void> = []
			const memberNow = () => options.isMember(peer.machineId)
			const count = (kind: 'auth' | 'unauth') => {
				counted = kind
				if (kind === 'auth') {
					authTotal++
					const set = byMachine.get(peer.machineId) ?? new Set<TLSSocket>()
					byMachine.set(peer.machineId, set)
					set.add(socket)
				} else {
					unauthTotal++
					unauthByAddress.set(sourceAddress, (unauthByAddress.get(sourceAddress) ?? 0) + 1)
				}
			}
			const uncount = () => {
				if (counted === 'auth') {
					authTotal--
					byMachine.get(peer.machineId)?.delete(socket)
				} else if (counted === 'unauth') {
					unauthTotal--
					const n = (unauthByAddress.get(sourceAddress) ?? 1) - 1
					if (n <= 0) unauthByAddress.delete(sourceAddress)
					else unauthByAddress.set(sourceAddress, n)
				}
				counted = undefined
			}
			const isMember = memberNow()
			if (isMember) {
				if (authTotal >= MAX_AUTH_CONNECTIONS) return refuse('too_many')
				count('auth')
			} else {
				if (
					unauthTotal >= MAX_UNAUTH_TOTAL ||
					(unauthByAddress.get(sourceAddress) ?? 0) >= MAX_UNAUTH_PER_ADDRESS
				) {
					return refuse('too_many')
				}
				count('unauth')
			}
			socket.on('close', () => {
				cancelDeadline?.()
				uncount()
				sockets.delete(socket)
				for (const c of closers) c()
			})
			const arm = (ms: number, reason: 'deadline') => {
				cancelDeadline?.()
				cancelDeadline = options.clock.setTimer(() => {
					if (!held) refuse(reason)
				}, ms)
			}
			arm(FIRST_LINE_DEADLINE_MS, 'deadline')

			let queue: Promise<void> = Promise.resolve()
			const context: ServerContext = {
				peer,
				get member() {
					return memberNow()
				},
				sourceAddress,
				holdOpen() {
					held = true
					cancelDeadline?.()
				},
				write(frame) {
					if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`)
				},
				onClose(cb) {
					closers.push(cb)
				},
				close() {
					socket.end()
				},
			}
			const handleLine = (line: string) => {
				cancelDeadline?.()
				const member = memberNow()
				if (isMember && !member) return refuse('not_member')
				if (!member && counted === 'auth') return refuse('not_member')
				let parsed: unknown
				try {
					parsed = JSON.parse(line)
				} catch {
					return refuse('bad_frame')
				}
				const request = NetRequestSchema.safeParse(parsed)
				if (!request.success) {
					socket.write(`${JSON.stringify({ error: 'bad_request' })}\n`)
					return refuse('bad_frame')
				}
				if (!member && !PREAUTH_OPS.has(request.data.op))
					return refuse('not_member', request.data.op)
				queue = queue.then(async () => {
					try {
						const response = await options.handle(request.data, context)
						if (!socket.destroyed && response !== undefined) context.write(response)
					} catch {
						if (!socket.destroyed) context.write({ error: 'internal' })
					}
					if (!held && !socket.destroyed)
						arm(member ? IDLE_DEADLINE_MS : FIRST_LINE_DEADLINE_MS, 'deadline')
				})
			}
			socket.on(
				'data',
				lines(
					handleLine,
					() => refuse('oversize'),
					() => (memberNow() ? MAX_NET_LINE_BYTES : MAX_PREAUTH_LINE_BYTES),
				),
			)
		})
	}

	return {
		async listen(host, port) {
			const server = createServer({
				key: exportMachineKeyPem(options.identity.key),
				cert: options.identity.certificatePem,
				requestCert: true,
				rejectUnauthorized: false,
				minVersion: 'TLSv1.3',
				handshakeTimeout: 10_000,
			})
			server.maxConnections = 64
			server.on('tlsClientError', () => undefined)
			track(server)
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject)
				server.listen({ host, port }, () => {
					server.off('error', reject)
					resolve()
				})
			})
			servers.push(server)
			return (server.address() as { port: number }).port
		},
		closeMachine(machineId) {
			for (const s of [...(byMachine.get(machineId) ?? [])]) s.destroy()
		},
		async close() {
			for (const s of sockets) s.destroy()
			await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
		},
		get connections() {
			return sockets.size
		},
	}
}

export interface DialOptions {
	readonly identity: TlsIdentity
	readonly host: string
	readonly port: number
	readonly clock: NetworkClock
	/** Refuse to continue unless the peer is this machine. */
	readonly expectMachineId?: string
	/** Refuse to continue unless this says the peer is acceptable (for example, a member). */
	readonly accept?: (peer: PeerInfo) => boolean
	readonly dialDeadlineMs?: number
}

export interface NetClient {
	readonly peer: PeerInfo
	/** Send one request and wait for the next frame. */
	request(request: object, deadlineMs?: number): Promise<unknown>
	/** Wait for the next frame, with no deadline (a pending join). */
	nextFrame(): Promise<unknown>
	close(): void
}

export const REQUEST_DEADLINE_MS = 2_000

export function dialNet(options: DialOptions): Promise<NetClient> {
	return new Promise((resolve, reject) => {
		const socket = connect({
			host: options.host.split('%')[0],
			port: options.port,
			key: exportMachineKeyPem(options.identity.key),
			cert: options.identity.certificatePem,
			rejectUnauthorized: false,
			minVersion: 'TLSv1.3',
		})
		const frames: unknown[] = []
		const waiters: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = []
		let dead: Error | undefined
		const fail = (error: Error) => {
			dead ??= error
			for (const w of waiters.splice(0)) w.reject(error)
			socket.destroy()
		}
		const cancelDial = options.clock.setTimer(() => {
			if (!settled) {
				settled = true
				reject(new NetworkError('timeout', 'The other machine did not answer in time.'))
				socket.destroy()
			}
		}, options.dialDeadlineMs ?? DIAL_DEADLINE_MS)
		let settled = false
		socket.on('error', (err) => {
			if (!settled) {
				settled = true
				cancelDial()
				reject(new NetworkError('dial', `Could not connect: ${err.message}`))
			}
			fail(new NetworkError('dial', 'The connection failed.'))
		})
		socket.on('close', () => fail(new NetworkError('dial', 'The connection closed.')))
		socket.on(
			'data',
			lines(
				(line) => {
					let value: unknown
					try {
						value = JSON.parse(line)
					} catch {
						return fail(
							new NetworkError('bad_frame', 'The other machine sent something unreadable.'),
						)
					}
					const waiter = waiters.shift()
					if (waiter) waiter.resolve(value)
					else frames.push(value)
				},
				() => fail(new NetworkError('bad_frame', 'The other machine sent too much.')),
				() => MAX_NET_LINE_BYTES,
			),
		)
		socket.once('secureConnect', () => {
			cancelDial()
			if (settled) return
			const peer = peerOf(socket)
			if (!peer) {
				settled = true
				socket.destroy()
				return reject(
					new NetworkError('not_member', 'The other machine did not present a certificate.'),
				)
			}
			if (
				(options.expectMachineId !== undefined && peer.machineId !== options.expectMachineId) ||
				(options.accept && !options.accept(peer))
			) {
				settled = true
				socket.destroy()
				return reject(new NetworkError('not_member', 'That machine is not the one expected.'))
			}
			settled = true
			const next = (): Promise<unknown> => {
				if (frames.length > 0) return Promise.resolve(frames.shift())
				if (dead) return Promise.reject(dead)
				return new Promise((res, rej) => waiters.push({ resolve: res, reject: rej }))
			}
			resolve({
				peer,
				nextFrame: next,
				request(request, deadlineMs = REQUEST_DEADLINE_MS) {
					socket.write(`${JSON.stringify(request)}\n`)
					return new Promise<unknown>((res, rej) => {
						const cancel = options.clock.setTimer(
							() => rej(new NetworkError('timeout', 'The other machine did not answer in time.')),
							deadlineMs,
						)
						next().then(
							(v) => {
								cancel()
								res(v)
							},
							(e) => {
								cancel()
								rej(e)
							},
						)
					})
				},
				close: () => socket.destroy(),
			})
		})
	})
}
