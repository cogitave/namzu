import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename } from 'node:path'
import {
	MAX_PEER_MESSAGE_TEXT_BYTES,
	MAX_PEER_REQUEST_BYTES,
	PEER_PROTOCOL_VERSION,
	PeerClient,
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
	const name = 'command line'
	const from = { sessionId, ref, name, address, mode: options.mode, kind: 'cli' as const }
	// The whole request line is capped, and quotes and control characters grow when
	// escaped, so a message that fits as text can still not fit as a request.
	const line = JSON.stringify({
		protocol: PEER_PROTOCOL_VERSION,
		op: 'deliver',
		token: peer.token,
		id,
		from,
		text: message,
	})
	if (Buffer.byteLength(line, 'utf8') + 1 > MAX_PEER_REQUEST_BYTES)
		return refused('Message is too large once encoded. Nothing was sent.', { ref: peer.ref })

	// The receiver pings this endpoint to verify the record before it accepts, so it
	// stays up for the whole request and is removed after.
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
		onNotice: () => {},
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
			kind: 'cli',
			title: name || basename(cwd),
			cwd,
			permissionMode: options.mode,
			state: 'busy',
			acceptsMessages: false,
			address,
			token,
			protocol: PEER_PROTOCOL_VERSION,
			cliVersion: options.version,
		})
		const result = await new PeerClient().deliver(peer, { id, from, text: message })
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
	} finally {
		detach()
		await endpoint.close().catch(() => {})
		removeRecord()
	}
}
