/**
 * A client for one connection of `namzu-peer/1`: connect, write one request
 * line, read one response line, close. Mirrors the shape of this
 * repository's other local control clients (`queryRunner` in
 * `packages/cli/src/integrations/resident/runner-control.ts`,
 * `callEndpoint` in `packages/cli/src/schedule/daemon/endpoint.ts`): an
 * authenticated response PROVES responsiveness, and its absence never proves
 * the peer is dead — only that this attempt could not reach it.
 *
 * @experimental
 */

import { createConnection } from 'node:net'
import { parsePeerAddress } from './address.js'
import {
	type DeliverRequest,
	type DeliverResponse,
	DeliverResponseSchema,
	MAX_PEER_REQUEST_BYTES,
	type NoticeRequest,
	type NoticeResponse,
	NoticeResponseSchema,
	PEER_PROTOCOL_VERSION,
	type PingRequest,
	type PingResponse,
	PingResponseSchema,
	type SubscribeIdleRequest,
	type SubscribeIdleResponse,
	SubscribeIdleResponseSchema,
} from './protocol.js'
import type { PeerRecord } from './record.js'

const DEFAULT_TIMEOUT_MS = 2_000

export class PeerClientError extends Error {
	override readonly name = 'PeerClientError'
}

/** An authenticated reply proves responsiveness; every other outcome names why none arrived. */
export type PeerClientResult<T> =
	| ({ readonly kind: 'responded' } & T)
	| { readonly kind: 'unreachable'; readonly reason: string }

function connectPath(address: string): string {
	const parsed = parsePeerAddress(address)
	if (parsed.scheme === 'a2a') {
		throw new PeerClientError(`PeerClient cannot dial an a2a: address directly: ${address}`)
	}
	return parsed.path
}

/** One request, one response, one connection. */
function sendPeerRequest<T>(
	address: string,
	request: unknown,
	parseResponse: (value: unknown) => T,
	timeoutMs: number,
): Promise<PeerClientResult<T>> {
	return new Promise((resolve) => {
		let settled = false
		const finish = (result: PeerClientResult<T>): void => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			socket.destroy()
			resolve(result)
		}
		const unreachable = (error: unknown): void =>
			finish({
				kind: 'unreachable',
				reason: error instanceof Error ? error.message : String(error),
			})
		const timer = setTimeout(() => unreachable(new Error('Peer request timed out.')), timeoutMs)
		let path: string
		try {
			path = connectPath(address)
		} catch (error) {
			clearTimeout(timer)
			resolve({
				kind: 'unreachable',
				reason: error instanceof Error ? error.message : String(error),
			})
			return
		}
		const socket = createConnection({ path })
		let buffered = Buffer.alloc(0)
		socket.once('error', unreachable)
		socket.once('close', () =>
			unreachable(new Error('Peer connection closed before a response arrived.')),
		)
		socket.once('connect', () => {
			socket.write(`${JSON.stringify(request)}\n`)
		})
		socket.on('data', (chunk: Buffer) => {
			if (buffered.length + chunk.length > MAX_PEER_REQUEST_BYTES) {
				unreachable(new Error('Peer response exceeded the size limit.'))
				return
			}
			buffered = Buffer.concat([buffered, chunk])
			const newline = buffered.indexOf(10)
			if (newline < 0) return
			try {
				const parsed: unknown = JSON.parse(buffered.subarray(0, newline).toString('utf8'))
				finish({ kind: 'responded', ...parseResponse(parsed) })
			} catch (error) {
				unreachable(error)
			}
		})
	})
}

export interface PeerClientOptions {
	/** Default 2000ms. */
	readonly timeoutMs?: number
}

/**
 * `ping`, `deliver`, `subscribe_idle` and `notice` over `namzu-peer/1`.
 *
 * `deliver`/`subscribeIdle`/`notice` read the RECIPIENT's token from the
 * `PeerRecord` passed in — the wire's token is always the recipient's own,
 * asserted by the caller and verified by the server (design §1.1, §1.3).
 * `ping` takes a bare address and carries no token; see the file header for
 * why.
 */
export class PeerClient {
	private readonly timeoutMs: number

	constructor(options: PeerClientOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
	}

	ping(address: string, timeoutMs = this.timeoutMs): Promise<PeerClientResult<PingResponse>> {
		const request: PingRequest = { protocol: PEER_PROTOCOL_VERSION, op: 'ping' }
		return sendPeerRequest(address, request, (value) => PingResponseSchema.parse(value), timeoutMs)
	}

	deliver(
		record: Pick<PeerRecord, 'address' | 'token'>,
		message: Omit<DeliverRequest, 'protocol' | 'op' | 'token'>,
	): Promise<PeerClientResult<DeliverResponse>> {
		const request: DeliverRequest = {
			protocol: PEER_PROTOCOL_VERSION,
			op: 'deliver',
			token: record.token,
			...message,
		}
		return sendPeerRequest(
			record.address,
			request,
			(value) => DeliverResponseSchema.parse(value),
			this.timeoutMs,
		)
	}

	subscribeIdle(
		record: Pick<PeerRecord, 'address' | 'token'>,
		message: Omit<SubscribeIdleRequest, 'protocol' | 'op' | 'token'>,
	): Promise<PeerClientResult<SubscribeIdleResponse>> {
		const request: SubscribeIdleRequest = {
			protocol: PEER_PROTOCOL_VERSION,
			op: 'subscribe_idle',
			token: record.token,
			...message,
		}
		return sendPeerRequest(
			record.address,
			request,
			(value) => SubscribeIdleResponseSchema.parse(value),
			this.timeoutMs,
		)
	}

	notice(
		record: Pick<PeerRecord, 'address' | 'token'>,
		message: Omit<NoticeRequest, 'protocol' | 'op' | 'token'>,
	): Promise<PeerClientResult<NoticeResponse>> {
		const request: NoticeRequest = {
			protocol: PEER_PROTOCOL_VERSION,
			op: 'notice',
			token: record.token,
			...message,
		}
		return sendPeerRequest(
			record.address,
			request,
			(value) => NoticeResponseSchema.parse(value),
			this.timeoutMs,
		)
	}
}

/** A bare liveness probe: `true` iff an unauthenticated `ping` answers within `timeoutMs`. Used by `listLivePeers`. */
export function pingPeer(address: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
	const request: PingRequest = { protocol: PEER_PROTOCOL_VERSION, op: 'ping' }
	return sendPeerRequest(
		address,
		request,
		(value) => PingResponseSchema.parse(value),
		timeoutMs,
	).then((result) => result.kind === 'responded')
}
