/**
 * The `namzu-peer/1` server: one UDS path (POSIX) or named pipe (win32) per
 * session, newline-delimited JSON framing, a closed op set (design §1.1,
 * §1.3). Mirrors the shape of this repository's other local control
 * endpoints (`startEndpoint` in
 * `packages/cli/src/schedule/daemon/endpoint.ts`, `createRunnerControlServer`
 * in `packages/cli/src/integrations/resident/runner-control.ts`): a total
 * read deadline per connection (not an inactivity timer a slow sender can
 * reset), a bounded connection count, and a destroyed socket rather than an
 * error response for anything malformed — request bytes and tokens are
 * never logged, so there is nothing to say about a bad request beyond
 * closing the connection.
 *
 * This package tests only the POSIX (UDS) path; the win32 branch is written
 * and reviewed, not exercised, since this environment cannot run a win32
 * test.
 *
 * @experimental
 */

import { timingSafeEqual } from 'node:crypto'
import { chmodSync, lstatSync, unlinkSync } from 'node:fs'
import { type Socket, createServer } from 'node:net'
import { parsePeerAddress } from './address.js'
import { pingPeer } from './client.js'
import {
	DEFAULT_PEER_READ_DEADLINE_MS,
	type DeliverRequest,
	type DeliverResponse,
	MAX_PEER_CONNECTIONS,
	MAX_PEER_REQUEST_BYTES,
	type NoticeRequest,
	type NoticeResponse,
	type PeerFrom,
	PeerRequestSchema,
	type PeerSessionState,
	type PingResponse,
	type SubscribeIdleRequest,
	type SubscribeIdleResponse,
} from './protocol.js'
import { isPeerRecordLive, readPeerRecord } from './registry.js'

export class PeerEndpointError extends Error {
	override readonly name = 'PeerEndpointError'
}

export interface CreatePeerEndpointOptions {
	readonly address: string
	/** This session's own token; compared against every request but `ping` with `timingSafeEqual`. */
	readonly token: string
	/** `undefined` models a platform with no uid (win32). Gates the stale-socket removal below. */
	readonly uid?: number
	/** Answered verbatim on every `ping`; `ping` has no other way to learn the current state. */
	readonly getState: () => PeerSessionState
	/**
	 * Directory holding the live-session registry (`sessions/<id>.json`),
	 * used by the DEFAULT `verifySender`. Not read at all if `verifySender`
	 * is supplied.
	 */
	readonly sessionsDir?: string
	readonly onDeliver: (request: DeliverRequest) => Promise<DeliverResponse> | DeliverResponse
	readonly onSubscribeIdle: (
		request: SubscribeIdleRequest,
	) => Promise<SubscribeIdleResponse> | SubscribeIdleResponse
	readonly onNotice: (request: NoticeRequest) => Promise<void> | void
	/**
	 * Default: the sender's registry record exists, is live
	 * ({@link isPeerRecordLive}), and its address equals `from.address`
	 * (design §1.3) — so a process cannot claim to be a session it does not
	 * own without also owning that session's live record.
	 */
	readonly verifySender?: (from: PeerFrom) => Promise<boolean> | boolean
	/** Default 2000ms; override for tests so a deadline test does not have to wait 2 real seconds. */
	readonly readDeadlineMs?: number
	/** Default 16; override for tests. */
	readonly maxConnections?: number
	/** Default 64 KiB; override for tests. */
	readonly maxRequestBytes?: number
	/** Default 500ms; the timeout the default `verifySender`'s liveness ping uses. */
	readonly livenessPingTimeoutMs?: number
}

export interface PeerEndpoint {
	readonly address: string
	/** Refuse new connections and destroy remaining sockets before resolving. */
	close(): Promise<void>
}

function defaultVerifySender(
	sessionsDir: string | undefined,
	livenessPingTimeoutMs: number | undefined,
): (from: PeerFrom) => Promise<boolean> {
	return async (from) => {
		if (!sessionsDir) return false
		const record = readPeerRecord(sessionsDir, from.sessionId)
		if (!record) return false
		if (record.address !== from.address) return false
		return isPeerRecordLive(record, { pingTimeoutMs: livenessPingTimeoutMs })
	}
}

/** Unlink `path` only if it is a socket owned by `uid` and nothing answers it. */
async function removeStaleSocket(path: string, uid: number | undefined): Promise<void> {
	let entry: ReturnType<typeof lstatSync>
	try {
		entry = lstatSync(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
		throw error
	}
	if (!entry.isSocket()) {
		throw new PeerEndpointError(`Refusing to bind ${path}: something else already exists there.`)
	}
	if (uid !== undefined && entry.uid !== uid) {
		throw new PeerEndpointError(
			`Refusing to bind ${path}: it is owned by uid ${entry.uid}, not ${uid}.`,
		)
	}
	const answers = await pingPeer(`uds:${path}`, 500)
	if (answers) {
		throw new PeerEndpointError(
			`Refusing to bind ${path}: another process is already listening there.`,
		)
	}
	try {
		unlinkSync(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
}

/**
 * Start serving `namzu-peer/1` on `options.address`.
 *
 * The four business-decision callbacks (`onDeliver`, `onSubscribeIdle`,
 * `onNotice`, and the default-overriding `verifySender`) decide outcomes;
 * this function owns only the transport: framing, the size/connection/
 * deadline limits, the closed op set, and token comparison.
 */
export async function createPeerEndpoint(
	options: CreatePeerEndpointOptions,
): Promise<PeerEndpoint> {
	const parsed = parsePeerAddress(options.address)
	if (parsed.scheme === 'a2a') {
		throw new PeerEndpointError(
			`createPeerEndpoint cannot serve an a2a: address: ${options.address}`,
		)
	}
	const listenPath = parsed.path
	if (parsed.scheme === 'uds') await removeStaleSocket(listenPath, options.uid)

	const expectedToken = Buffer.from(options.token)
	const maxConnections = options.maxConnections ?? MAX_PEER_CONNECTIONS
	const maxRequestBytes = options.maxRequestBytes ?? MAX_PEER_REQUEST_BYTES
	const readDeadlineMs = options.readDeadlineMs ?? DEFAULT_PEER_READ_DEADLINE_MS
	const verifySender =
		options.verifySender ?? defaultVerifySender(options.sessionsDir, options.livenessPingTimeoutMs)

	function tokenMatches(candidate: string): boolean {
		const presented = Buffer.from(candidate)
		return presented.length === expectedToken.length && timingSafeEqual(presented, expectedToken)
	}

	const sockets = new Set<Socket>()
	let closing = false

	const server = createServer((socket) => {
		socket.on('error', () => {})
		if (closing || sockets.size >= maxConnections) {
			socket.destroy()
			return
		}
		sockets.add(socket)
		socket.once('close', () => sockets.delete(socket))
		// A total deadline, not an inactivity timer a slow sender could reset.
		const deadline = setTimeout(() => socket.destroy(), readDeadlineMs)
		socket.once('close', () => clearTimeout(deadline))
		let buffered = Buffer.alloc(0)
		let handled = false

		function respond(
			payload: PingResponse | DeliverResponse | SubscribeIdleResponse | NoticeResponse,
		): void {
			if (!socket.destroyed) socket.end(`${JSON.stringify(payload)}\n`)
		}

		async function handleLine(line: Buffer): Promise<void> {
			let parsedJson: unknown
			try {
				parsedJson = JSON.parse(line.toString('utf8'))
			} catch {
				socket.destroy()
				return
			}
			// Malformed, or an op outside the closed set: destroyed with no
			// response. Never logged — request bytes and tokens never reach a log.
			const result = PeerRequestSchema.safeParse(parsedJson)
			if (!result.success) {
				socket.destroy()
				return
			}
			const request = result.data
			switch (request.op) {
				case 'ping': {
					respond({ ok: true, state: options.getState() })
					return
				}
				case 'deliver': {
					if (!tokenMatches(request.token)) {
						socket.destroy()
						return
					}
					if (!(await verifySender(request.from))) {
						respond({ status: 'refused', reason: 'sender identity could not be verified' })
						return
					}
					respond(await options.onDeliver(request))
					return
				}
				case 'subscribe_idle': {
					if (!tokenMatches(request.token)) {
						socket.destroy()
						return
					}
					if (!(await verifySender(request.from))) {
						respond({ status: 'refused' })
						return
					}
					respond(await options.onSubscribeIdle(request))
					return
				}
				case 'notice': {
					if (!tokenMatches(request.token)) {
						socket.destroy()
						return
					}
					await options.onNotice(request)
					respond({ ok: true })
					return
				}
			}
		}

		socket.on('data', (chunk: Buffer) => {
			if (handled) return
			if (buffered.length + chunk.length > maxRequestBytes) {
				socket.destroy()
				return
			}
			buffered = Buffer.concat([buffered, chunk])
			const newline = buffered.indexOf(10)
			if (newline < 0) return
			handled = true
			if (newline !== buffered.length - 1) {
				// One request per connection: anything after the first line is
				// refused rather than silently dropped.
				socket.destroy()
				return
			}
			void handleLine(buffered.subarray(0, newline)).catch(() => socket.destroy())
		})
	})

	await new Promise<void>((resolve, reject) => {
		const failed = (error: Error): void => reject(error)
		server.once('error', failed)
		server.listen({ path: listenPath }, () => {
			server.removeListener('error', failed)
			resolve()
		})
	})
	server.on('error', () => {})

	if (parsed.scheme === 'uds') chmodSync(listenPath, 0o600)

	const close = (): Promise<void> =>
		new Promise<void>((resolve) => {
			closing = true
			for (const socket of sockets) socket.destroy()
			server.close(() => resolve())
		})

	return { address: options.address, close }
}
