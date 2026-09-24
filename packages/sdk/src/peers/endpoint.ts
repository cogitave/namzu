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
import { basename } from 'node:path'
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
import type { PeerRecord } from './record.js'
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
	 * Verify a sender's asserted identity, and return the identity the
	 * recipient should actually use — which is never simply `from` handed
	 * back, because a value the recipient uses for a decision (`mode`,
	 * `kind`) or shows the operator (`name`, `ref`) must come from something
	 * the sender does not control on this one connection. `false` refuses.
	 *
	 * Default ({@link defaultVerifySender}): the sender's registry record
	 * exists, is live ({@link isPeerRecordLive}), its `address` equals
	 * `from.address`, and its `permissionMode`/`kind` equal `from.mode`/
	 * `from.kind` (design §1.3) — so a process cannot claim to be a session
	 * it does not own, and a session cannot claim a mode or kind other than
	 * the one it registered. The identity returned on success is built
	 * entirely from the record: `name` is the record's own display name
	 * (`title`, or the last path segment of `cwd` when unset), never the
	 * wire's `from.name`.
	 */
	readonly verifySender?: (from: PeerFrom) => Promise<PeerFrom | false> | PeerFrom | false
	/** Default 2000ms; override for tests so a deadline test does not have to wait 2 real seconds. */
	readonly readDeadlineMs?: number
	/** Default 16; override for tests. */
	readonly maxConnections?: number
	/** Default 64 KiB; override for tests. */
	readonly maxRequestBytes?: number
	/** Default 500ms; the timeout the default `verifySender`'s liveness ping uses. */
	readonly livenessPingTimeoutMs?: number
	/** Default {@link MAX_OUTSTANDING_PEERS}; override for tests. */
	readonly maxOutstandingPeers?: number
	/** Default {@link MAX_OUTSTANDING_PER_PEER}; override for tests. */
	readonly maxOutstandingPerPeer?: number
	/** Default {@link OUTSTANDING_EXPIRY_MS}; override for tests. */
	readonly outstandingExpiryMs?: number
	/** Default `Date.now`; injectable so an expiry test does not have to wait 24 real hours. */
	readonly now?: () => number
}

export interface PeerEndpoint {
	readonly address: string
	/** Refuse new connections and destroy remaining sockets before resolving. */
	close(): Promise<void>
	/**
	 * Record that THIS session sent a `deliver` to `peerSessionId` and so
	 * expects a `delivery` notice back about it. A `notice` naming a peer
	 * with no outstanding delivery is refused (§1.3): a session that never
	 * dealt with this recipient cannot manufacture an outcome for a message
	 * that was never sent. Counted, not boolean — several messages to the
	 * same peer may be outstanding at once, and each accepted notice
	 * consumes exactly one. Bounded and expiring
	 * ({@link MAX_OUTSTANDING_PEERS} distinct peers, {@link
	 * MAX_OUTSTANDING_PER_PEER} per peer, {@link OUTSTANDING_EXPIRY_MS}
	 * idle), so a peer that never answers cannot pin memory forever and a
	 * session cannot be driven to register unbounded distinct peer ids.
	 */
	registerOutstandingDelivery(peerSessionId: string): void
	/**
	 * Record that THIS session subscribed (directly, or via
	 * `deliver.subscribeIdle`) to `peerSessionId`'s idle/exit notice. An
	 * `idle`/`exited` notice naming a peer with no outstanding subscription
	 * is refused, the same reasoning as {@link registerOutstandingDelivery},
	 * with the same bound and expiry.
	 */
	registerOutstandingSubscription(peerSessionId: string): void
}

/** The record's display name: its own `title` when set, else the last path segment of `cwd`. */
function peerRecordDisplayName(record: PeerRecord): string {
	const title = record.title?.trim()
	return title && title.length > 0 ? title : basename(record.cwd)
}

/** The identity a verified sender's record backs — never the wire's own claim. */
function peerFromRecord(record: PeerRecord): PeerFrom {
	return {
		sessionId: record.sessionId,
		ref: record.ref,
		name: peerRecordDisplayName(record),
		address: record.address,
		mode: record.permissionMode,
		kind: record.kind,
	}
}

function defaultVerifySender(
	sessionsDir: string | undefined,
	livenessPingTimeoutMs: number | undefined,
): (from: PeerFrom) => Promise<PeerFrom | false> {
	return async (from) => {
		if (!sessionsDir) return false
		const record = readPeerRecord(sessionsDir, from.sessionId)
		if (!record) return false
		if (record.address !== from.address) return false
		// A sender's own record is the only thing worth trusting for a value
		// the recipient uses to decide anything (the mode-mismatch hold gate)
		// or to show the operator: the wire's claim is refused outright rather
		// than silently corrected, so a session cannot launder a lower-trust
		// mode or kind into a higher-trust one just by asserting it here.
		if (record.permissionMode !== from.mode) return false
		if (record.kind !== from.kind) return false
		if (!(await isPeerRecordLive(record, { pingTimeoutMs: livenessPingTimeoutMs }))) return false
		return peerFromRecord(record)
	}
}

/**
 * Distinct peer sessions an endpoint's outstanding-delivery or
 * outstanding-subscription table tracks at once, before the oldest is
 * evicted to make room. A session that talks to hundreds of distinct peers
 * without ever hearing back from most of them is already an anomaly this
 * table should not have to hold unbounded memory for.
 */
export const MAX_OUTSTANDING_PEERS = 256

/**
 * Outstanding relationships tracked for any ONE peer at once, before further
 * registrations for that same peer stop increasing the count. Generous
 * enough for many messages or resubscriptions in flight to a single busy
 * peer; still a bound, so one peer cannot itself grow this table's memory
 * without limit by being registered against repeatedly.
 */
export const MAX_OUTSTANDING_PER_PEER = 64

/**
 * How long an outstanding delivery or subscription is honoured with no
 * activity before it is swept away on its own, matching the design's
 * `notify_when_idle` subscription expiry (§1.7): a peer that never answers —
 * crashed, or simply never will — must not pin memory forever.
 */
export const OUTSTANDING_EXPIRY_MS = 24 * 60 * 60 * 1000

interface OutstandingEntry {
	count: number
	expiresAt: number
}

/**
 * A bounded, expiring, per-peer count of outstanding relationships this
 * session is owed a notice for (an outstanding `deliver` it sent, or a
 * subscription it made). Both {@link CreatePeerEndpointOptions.
 * maxOutstandingPeers} tables (deliveries, subscriptions) use one of these,
 * independently.
 *
 * Eviction is oldest-registered-first (Map iteration order, which is
 * insertion order in JavaScript and is left undisturbed by an in-place count
 * update) once {@link MAX_OUTSTANDING_PEERS} distinct peers are tracked at
 * once — a plain, easy-to-reason-about FIFO bound rather than a true LRU,
 * which this table does not need: it does not matter WHICH excess peer is
 * forgotten first, only that the table cannot grow without bound.
 */
class BoundedOutstandingTable {
	private readonly entries = new Map<string, OutstandingEntry>()

	constructor(
		private readonly maxPeers: number,
		private readonly maxPerPeer: number,
		private readonly expiryMs: number,
		private readonly now: () => number,
	) {}

	private sweepExpired(): void {
		const nowMs = this.now()
		for (const [peerSessionId, entry] of this.entries) {
			if (entry.expiresAt <= nowMs) this.entries.delete(peerSessionId)
		}
	}

	register(peerSessionId: string): void {
		this.sweepExpired()
		const existing = this.entries.get(peerSessionId)
		if (existing) {
			existing.count = Math.min(existing.count + 1, this.maxPerPeer)
			existing.expiresAt = this.now() + this.expiryMs
			return
		}
		if (this.entries.size >= this.maxPeers) {
			const oldestKey = this.entries.keys().next().value
			if (oldestKey !== undefined) this.entries.delete(oldestKey)
		}
		this.entries.set(peerSessionId, { count: 1, expiresAt: this.now() + this.expiryMs })
	}

	/** Consume one outstanding relationship, if any is on record; `false` when there is none to correlate to. */
	consume(peerSessionId: string): boolean {
		this.sweepExpired()
		const existing = this.entries.get(peerSessionId)
		if (!existing || existing.count <= 0) return false
		if (existing.count === 1) this.entries.delete(peerSessionId)
		else existing.count -= 1
		return true
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
	const now = options.now ?? Date.now
	const maxOutstandingPeers = options.maxOutstandingPeers ?? MAX_OUTSTANDING_PEERS
	const maxOutstandingPerPeer = options.maxOutstandingPerPeer ?? MAX_OUTSTANDING_PER_PEER
	const outstandingExpiryMs = options.outstandingExpiryMs ?? OUTSTANDING_EXPIRY_MS
	const outstandingDeliveries = new BoundedOutstandingTable(
		maxOutstandingPeers,
		maxOutstandingPerPeer,
		outstandingExpiryMs,
		now,
	)
	const outstandingSubscriptions = new BoundedOutstandingTable(
		maxOutstandingPeers,
		maxOutstandingPerPeer,
		outstandingExpiryMs,
		now,
	)

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
					const verifiedFrom = await verifySender(request.from)
					if (!verifiedFrom) {
						respond({ status: 'refused', reason: 'sender identity could not be verified' })
						return
					}
					respond(await options.onDeliver({ ...request, from: verifiedFrom }))
					return
				}
				case 'subscribe_idle': {
					if (!tokenMatches(request.token)) {
						socket.destroy()
						return
					}
					const verifiedFrom = await verifySender(request.from)
					if (!verifiedFrom) {
						respond({ status: 'refused' })
						return
					}
					respond(await options.onSubscribeIdle({ ...request, from: verifiedFrom }))
					return
				}
				case 'notice': {
					if (!tokenMatches(request.token)) {
						socket.destroy()
						return
					}
					const verifiedFrom = await verifySender(request.from)
					if (!verifiedFrom) {
						respond({ ok: false })
						return
					}
					// A session only ever reports a notice about ITSELF (§1.3): the
					// object of a `delivery` notice is "the peer your message went
					// to", and of an `idle`/`exited` notice, "the peer you
					// subscribed to" — in both cases the notifier, never a third
					// session it has no standing to speak for.
					if (verifiedFrom.sessionId !== request.about.sessionId) {
						respond({ ok: false })
						return
					}
					// And it must correlate to a relationship THIS session actually
					// has with that peer — a message it sent, or a subscription it
					// made — not merely to a verified, live, honestly-registered
					// sender with no dealings with this recipient at all.
					const correlated =
						request.kind === 'delivery'
							? outstandingDeliveries.consume(verifiedFrom.sessionId)
							: outstandingSubscriptions.consume(verifiedFrom.sessionId)
					if (!correlated) {
						respond({ ok: false })
						return
					}
					await options.onNotice({
						...request,
						from: verifiedFrom,
						about: { ...request.about, name: verifiedFrom.name, ref: verifiedFrom.ref },
					})
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

	return {
		address: options.address,
		close,
		registerOutstandingDelivery: (peerSessionId) => outstandingDeliveries.register(peerSessionId),
		registerOutstandingSubscription: (peerSessionId) =>
			outstandingSubscriptions.register(peerSessionId),
	}
}
