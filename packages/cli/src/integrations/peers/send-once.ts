import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename } from 'node:path'
import {
	type DeliverResponse,
	MAX_PEER_MESSAGE_TEXT_BYTES,
	MAX_PEER_REQUEST_BYTES,
	type NoticeRequest,
	PEER_PROTOCOL_VERSION,
	PeerClient,
	type PeerClientResult,
	type PeerRecord,
	createPeerEndpoint,
	derivePeerRef,
	generateSessionId,
	isPeerRecordLive,
	pipePeerAddress,
	readPeerRecords,
	removePeerRecord,
	udsPeerAddress,
	writePeerRecord,
} from '@namzu/sdk'
import { resolvePeerRuntime } from './runtime.js'

/**
 * One message from a command line to a live terminal, without opening a TUI.
 *
 * The sender is a short-lived `cli` record in the same registry a terminal
 * writes: same project folder, same runtime directory, and the permission mode
 * it declares. The receiver checks all three exactly as it does for a terminal,
 * and shows the mail as coming from a command line, never as the operator.
 */

export type PeerSendStatus = 'queued' | 'refused' | 'unreachable'

export interface PeerSendReceipt {
	readonly status: PeerSendStatus
	readonly reason: string
	readonly ref?: string
	readonly sessionId?: string
	readonly id?: string
}

export interface PeerListing {
	readonly ref: string
	readonly sessionId: string
	readonly title: string
	readonly state: string
	readonly mode: string
	readonly acceptsMessages: boolean
}

export interface PeerCommandOptions {
	readonly home: string
	readonly cwd: string
	readonly version: string
	readonly env?: NodeJS.ProcessEnv
}

/** The listed sessions: live terminals in this project, never their tokens or addresses. */
export async function listProjectTerminals(options: PeerCommandOptions): Promise<PeerListing[]> {
	const runtime = resolvePeerRuntime(options.home, options.env ?? process.env)
	const cwd = realpathSync(options.cwd)
	const records = readPeerRecords(runtime.sessionsDir).filter(
		(peer) => peer.cwd === cwd && peer.kind === 'tui',
	)
	const live = await Promise.all(
		records.map(async (peer) => ((await isPeerRecordLive(peer)) ? peer : undefined)),
	)
	return live
		.filter((peer): peer is PeerRecord => peer !== undefined)
		.sort((a, b) => a.startedAt - b.startedAt)
		.map((peer) => ({
			ref: peer.ref,
			sessionId: peer.sessionId,
			title: peer.title ?? peer.ref,
			state: peer.state,
			mode: peer.permissionMode,
			acceptsMessages: peer.acceptsMessages,
		}))
}

const refused = (reason: string, extra: Partial<PeerSendReceipt> = {}): PeerSendReceipt => ({
	status: 'refused',
	reason,
	...extra,
})

/**
 * Send `message` to one terminal and report the receipt. `mode` is the
 * permission mode this sender acts under; the receiver refuses a mismatch.
 */
export async function sendToTerminal(
	options: PeerCommandOptions & {
		readonly target: string
		readonly message: string
		readonly mode: string
		/** What to do after cleanup when a signal ends the send; by default the signal is re-raised. */
		readonly exitOnSignal?: (signal: NodeJS.Signals) => void
	},
): Promise<PeerSendReceipt> {
	const { message } = options
	if (!message.trim()) return refused('Message must contain text.')
	if (Buffer.byteLength(message, 'utf8') > MAX_PEER_MESSAGE_TEXT_BYTES)
		return refused(
			`Message is over the ${MAX_PEER_MESSAGE_TEXT_BYTES / 1024} KiB limit. Nothing was sent.`,
		)
	const runtime = resolvePeerRuntime(options.home, options.env ?? process.env)
	const cwd = realpathSync(options.cwd)
	const candidates = readPeerRecords(runtime.sessionsDir).filter(
		(peer) =>
			peer.cwd === cwd &&
			peer.kind === 'tui' &&
			(peer.sessionId === options.target ||
				peer.ref === options.target ||
				peer.title === options.target),
	)
	if (candidates.length !== 1 || !candidates[0])
		return refused(
			candidates.length
				? 'The target matches more than one terminal; use its ref.'
				: 'No matching terminal in this project. Run namzu peers list.',
		)
	const peer = candidates[0]
	if (!peer.acceptsMessages)
		return refused('The target is not accepting messages.', { ref: peer.ref })
	if (!(await isPeerRecordLive(peer)))
		return {
			status: 'unreachable',
			reason: 'The target did not answer. No message was sent.',
			ref: peer.ref,
		}

	const sent = await deliverAsEphemeralSender({
		home: options.home,
		cwd,
		version: options.version,
		runtime,
		peer,
		message,
		kind: 'cli',
		name: 'command line',
		mode: options.mode,
		...(options.exitOnSignal ? { exitOnSignal: options.exitOnSignal } : {}),
	})
	if (sent.kind === 'too-large')
		return refused('Message is too large once encoded. Nothing was sent.', { ref: peer.ref })
	const { id, result } = sent
	if (result.kind !== 'responded')
		return {
			status: 'unreachable',
			reason: 'No receipt arrived; acceptance is unknown. Do not automatically retry.',
			ref: peer.ref,
			id,
		}
	const status = result.status === 'queued' ? 'queued' : 'refused'
	return {
		status,
		reason:
			result.reason ??
			(status === 'queued' ? 'Accepted in the live inbox.' : 'The terminal refused the message.'),
		ref: peer.ref,
		sessionId: peer.sessionId,
		id,
	}
}

export interface EphemeralSend<T = undefined> {
	readonly home: string
	readonly cwd: string
	readonly version: string
	readonly runtime: ReturnType<typeof resolvePeerRuntime>
	readonly peer: PeerRecord
	readonly message: string
	/** `cli` for `namzu peers send`, `person` for the operator's own words from another terminal. */
	readonly kind: 'cli' | 'person'
	readonly name: string
	readonly mode: string
	/** The conversation the sender means; the receiver refuses if it is on another by now. */
	readonly conversation?: string
	/** What to do after cleanup when a signal ends the send; by default the signal is re-raised. */
	readonly exitOnSignal?: (signal: NodeJS.Signals) => void
	/**
	 * Called with each notice the receiver sends back about this message, while the sender's endpoint
	 * is still up. Registering it also records the delivery as outstanding, which the endpoint needs
	 * before it believes a delivery notice about the peer.
	 */
	readonly onNotice?: (notice: NoticeRequest) => void
	/** Runs after the receipt, still inside the sender's lifetime (the endpoint and record exist). */
	readonly after?: (sent: { readonly id: string }) => Promise<T>
}

export type EphemeralOutcome<T> =
	| { readonly kind: 'too-large' }
	| {
			readonly kind: 'sent'
			readonly id: string
			readonly result: PeerClientResult<DeliverResponse>
			readonly after: T | undefined
	  }

/**
 * One deliver from a short-lived sender that owns a record and an endpoint for exactly as long as the
 * call: the receiver pings that endpoint to verify the record before it accepts, so it stays up for the
 * whole request (and for `after`), and the record and socket are removed on the way out, signals included.
 */
export async function deliverAsEphemeralSender<T = undefined>(
	options: EphemeralSend<T>,
): Promise<EphemeralOutcome<T>> {
	const { runtime, peer, message } = options
	const sessionId = generateSessionId()
	const ref = derivePeerRef(sessionId)
	const id = generateSessionId()
	const address =
		process.platform === 'win32'
			? pipePeerAddress(
					createHash('sha256').update(options.home).digest('hex').slice(0, 16),
					sessionId,
				)
			: udsPeerAddress(runtime.path, sessionId)
	const token = randomBytes(32).toString('hex')
	const uid = process.getuid?.()
	const name = options.name
	const from = { sessionId, ref, name, address, mode: options.mode, kind: options.kind }
	// The whole request line is capped, and quotes and control characters grow when
	// escaped, so a message that fits as text can still not fit as a request.
	const line = JSON.stringify({
		protocol: PEER_PROTOCOL_VERSION,
		op: 'deliver',
		token: peer.token,
		id,
		from,
		text: message,
		...(options.conversation ? { conversation: options.conversation } : {}),
	})
	if (Buffer.byteLength(line, 'utf8') + 1 > MAX_PEER_REQUEST_BYTES) return { kind: 'too-large' }

	const endpoint = await createPeerEndpoint({
		address,
		token,
		uid,
		sessionsDir: runtime.sessionsDir,
		getState: () => 'busy',
		onDeliver: () => ({ status: 'refused', reason: 'A command-line sender takes no messages.' }),
		onSubscribeIdle: () => ({
			status: 'refused',
			reason: 'A command-line sender takes no messages.',
		}),
		onNotice: (notice) => options.onNotice?.(notice),
	})
	const removeRecord = () => {
		try {
			removePeerRecord(runtime.sessionsDir, sessionId, uid)
		} catch {
			// A leftover record of a dead pid is cleaned by the next list.
		}
	}
	// A signal skips `finally`; without this the record and socket outlive the send.
	const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
	const handlers = new Map<NodeJS.Signals, () => void>()
	const detach = () => {
		for (const [name, handler] of handlers) process.removeListener(name, handler)
	}
	for (const name of signals) {
		const handler = () => {
			detach()
			removeRecord()
			void endpoint
				.close()
				.catch(() => {})
				.then(() => (options.exitOnSignal ?? ((sig) => process.kill(process.pid, sig)))(name))
		}
		handlers.set(name, handler)
		process.once(name, handler)
	}
	try {
		writePeerRecord(runtime.sessionsDir, {
			v: 1,
			sessionId,
			ref,
			pid: process.pid,
			startedAt: Date.now(),
			kind: options.kind,
			title: name || basename(options.cwd),
			cwd: options.cwd,
			permissionMode: options.mode,
			state: 'busy',
			acceptsMessages: false,
			address,
			token,
			protocol: PEER_PROTOCOL_VERSION,
			cliVersion: options.version,
		})
		if (options.onNotice) endpoint.registerOutstandingDelivery(peer.sessionId)
		const result = await new PeerClient().deliver(peer, {
			id,
			from,
			text: message,
			...(options.conversation ? { conversation: options.conversation } : {}),
		})
		const after =
			options.after && result.kind === 'responded' && result.status === 'queued'
				? await options.after({ id })
				: undefined
		return { kind: 'sent', id, result, after }
	} finally {
		detach()
		await endpoint.close().catch(() => {})
		removeRecord()
	}
}
