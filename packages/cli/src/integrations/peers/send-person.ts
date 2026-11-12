import { realpathSync } from 'node:fs'
import {
	MAX_PEER_MESSAGE_TEXT_BYTES,
	isPeerRecordLive,
	readPeerRecords,
	removePeerRecord,
} from '@namzu/sdk'
import type { PeerRecord, TenantId } from '@namzu/sdk'
import {
	SessionFollower,
	SessionNotFoundError,
	SessionNotOwnedError,
	SessionUnreadableError,
	type WatchStatus,
	findSession,
} from '../sessions/session-watch.js'
import { runsUnderAny } from './process-ancestry.js'
import { resolvePeerRuntime } from './runtime.js'
import { deliverAsEphemeralSender } from './send-once.js'

/**
 * The person's own words, from another terminal, to a session that is running somewhere on this machine.
 *
 * The session is chosen the way `namzu watch` chooses it (an id or the start of one, across this
 * account's folders). The message goes to the live terminal that has that conversation open, over the
 * same local endpoint messages between terminals use: it is put where that process looks, and that
 * process records it and hands it to the model. This code never opens the session's log for writing and
 * never takes its lease; it reads the log and the lease only to say, when nobody answers, why.
 */

/**
 * - `delivered`: the session's process took the message into the turn it is running (it will be recorded
 *   and sent with the model's next request).
 * - `accepted`: the process accepted it into its inbox and has not taken it yet; it stays queued there.
 * - `refused`: a process answered and declined, or the session is one that does not read messages.
 * - `unreachable`: nothing runs the session (finished, gone) or nothing answered.
 * - `not-found`: no such session, or not this account's.
 */
export type SessionSendStatus = 'delivered' | 'accepted' | 'refused' | 'unreachable' | 'not-found'

export interface SessionSendReceipt {
	readonly status: SessionSendStatus
	readonly reason: string
	/** The conversation the message was addressed to, once it was found. */
	readonly sessionId?: string
	readonly id?: string
}

export interface SessionSendOptions {
	/** `NAMZU_HOME`. */
	readonly home: string
	readonly tenantId: TenantId
	readonly currentSlug?: string
	/** Where the sender runs; its record needs a folder. */
	readonly cwd: string
	readonly version: string
	readonly env?: NodeJS.ProcessEnv
	/** A whole session id, or the start of one. */
	readonly session: string
	readonly message: string
	/**
	 * Resolves when the wait for "taken" is over. Absent: do not wait, answer once the message is
	 * accepted. The command supplies a timer; tests supply a promise they settle themselves.
	 */
	readonly window?: Promise<void>
	readonly now?: () => number
	readonly isProcessAlive?: (pid: number) => boolean
	/** The parent of a process, to tell a person's terminal from a tool a session started. */
	readonly parentPid?: (pid: number) => number | undefined
	readonly exitOnSignal?: (signal: NodeJS.Signals) => void
}

const receipt = (
	status: SessionSendStatus,
	reason: string,
	extra: Partial<SessionSendReceipt> = {},
): SessionSendReceipt => ({ status, reason, ...extra })

function defaultAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

/** Why no live terminal answers for a session, from what its log and lease say. */
function whyNobody(
	status: WatchStatus,
	silent: 'gone' | 'not-answering' | undefined,
): SessionSendReceipt {
	if (silent === 'gone')
		return receipt(
			'unreachable',
			'The terminal that had this conversation open is gone: its process has ended. Nothing was sent.',
		)
	if (silent === 'not-answering')
		return receipt(
			'unreachable',
			'The terminal that has this conversation open is running but does not answer (it may be stopped or stuck). Nothing was sent.',
		)
	switch (status.state) {
		case 'running':
		case 'waiting':
			return receipt(
				'refused',
				'A turn is running, but no terminal that reads messages is on this conversation. A background, scheduled or non-interactive run does not read messages, and neither does a run on another machine. Nothing was sent.',
			)
		case 'interrupted':
			return receipt(
				'unreachable',
				'The session was interrupted: the process that ran it is gone. Nothing was sent.',
			)
		default:
			return receipt(
				'unreachable',
				'The session is not running: nothing has it open. Nothing was sent.',
			)
	}
}

/** Send `message` to the session and say, honestly, how far it got. */
export async function sendToSession(options: SessionSendOptions): Promise<SessionSendReceipt> {
	const { message } = options
	if (!message.trim()) return receipt('refused', 'Message must contain text. Nothing was sent.')
	if (Buffer.byteLength(message, 'utf8') > MAX_PEER_MESSAGE_TEXT_BYTES)
		return receipt(
			'refused',
			`Message is over the ${MAX_PEER_MESSAGE_TEXT_BYTES / 1024} KiB limit. Nothing was sent.`,
		)
	const base = {
		root: options.home,
		tenantId: options.tenantId,
		...(options.currentSlug ? { currentSlug: options.currentSlug } : {}),
	}
	let target: Awaited<ReturnType<typeof findSession>>
	let status: WatchStatus
	try {
		target = await findSession(base, options.session)
		// Read-only: this also checks the log is verifiable and this account's, as the session list does.
		const snapshot = await new SessionFollower({
			target,
			...(options.now ? { now: options.now } : {}),
			...(options.isProcessAlive ? { isProcessAlive: options.isProcessAlive } : {}),
		}).poll()
		status = snapshot.status
	} catch (error) {
		if (
			error instanceof SessionNotFoundError ||
			error instanceof SessionNotOwnedError ||
			error instanceof SessionUnreadableError
		)
			return receipt('not-found', error.message)
		throw error
	}
	const sessionId = target.sessionId as string
	const runtime = resolvePeerRuntime(options.home, options.env ?? process.env)
	const records = readPeerRecords(runtime.sessionsDir).filter(
		(peer) => peer.kind === 'tui' && peer.conversationId === sessionId,
	)
	// The sender's own leftovers (a killed `namzu send` cannot clean up after itself) go first.
	const alive = options.isProcessAlive ?? defaultAlive
	for (const stale of readPeerRecords(runtime.sessionsDir))
		if (stale.kind === 'person' && !alive(stale.pid)) {
			try {
				removePeerRecord(runtime.sessionsDir, stale.sessionId, process.getuid?.())
			} catch {
				// Another process may have removed it already.
			}
		}
	const live: PeerRecord[] = []
	for (const peer of records) if (await isPeerRecordLive(peer)) live.push(peer)
	if (live.length === 0)
		return {
			...whyNobody(
				status,
				records.length === 0
					? undefined
					: records.some((peer) => alive(peer.pid))
						? 'not-answering'
						: 'gone',
			),
			sessionId,
		}
	// A person's message comes from outside every Namzu session. A command a model ran through its shell
	// descends from the terminal that runs it: say so here, before anything is sent. The receiving
	// terminal checks the same, so this is not the only guard.
	const sessionPids = new Set<number>(
		readPeerRecords(runtime.sessionsDir)
			.filter((peer) => peer.kind === 'tui')
			.map((peer) => peer.pid),
	)
	if (runsUnderAny(process.pid, sessionPids, options.parentPid))
		return receipt(
			'refused',
			'This command is running inside a Namzu session, as a tool or an agent. A message to a session is from a person at another terminal; run it from your own terminal. Nothing was sent.',
			{ sessionId },
		)
	if (live.length > 1)
		return receipt(
			'refused',
			`${live.length} terminals have this conversation open (${live.map((peer) => peer.ref).join(', ')}). Nothing was sent.`,
			{ sessionId },
		)
	const peer = live[0] as PeerRecord
	if (!peer.acceptsMessages)
		return receipt(
			'refused',
			'The terminal is not accepting messages (messaging is off or it is not ready). Nothing was sent.',
			{ sessionId },
		)

	// The notice can arrive before the receipt does, so what was taken is kept by id.
	const takenIds = new Set<string>()
	const waiting: Array<() => void> = []
	const sent = await deliverAsEphemeralSender<boolean>({
		home: options.home,
		cwd: realpathSync(options.cwd),
		version: options.version,
		runtime,
		peer,
		message,
		kind: 'person',
		name: 'person',
		mode: 'person',
		conversation: sessionId,
		...(options.exitOnSignal ? { exitOnSignal: options.exitOnSignal } : {}),
		onNotice: (notice) => {
			if (notice.kind !== 'delivery' || notice.outcome !== 'delivered' || !notice.detail) return
			takenIds.add(notice.detail)
			for (const wake of waiting.splice(0)) wake()
		},
		after: async ({ id }) => {
			if (takenIds.has(id)) return true
			if (!options.window) return false
			const wasTaken = new Promise<true>((resolve) => {
				waiting.push(() => takenIds.has(id) && resolve(true))
			})
			return Promise.race([wasTaken, options.window.then(() => false)])
		},
	})
	if (sent.kind === 'too-large')
		return receipt('refused', 'Message is too large once encoded. Nothing was sent.', { sessionId })
	const { id, result } = sent
	if (result.kind !== 'responded')
		return receipt(
			'unreachable',
			'No receipt arrived; acceptance is unknown. Do not automatically retry.',
			{ sessionId, id },
		)
	if (result.status !== 'queued')
		return receipt('refused', result.reason ?? 'The terminal refused the message.', {
			sessionId,
			id,
		})
	return sent.after === true
		? receipt('delivered', 'The session took the message into its turn.', { sessionId, id })
		: receipt(
				'accepted',
				'Accepted into the session’s inbox; it has not taken it yet and it stays queued there until it does or the terminal closes.',
				{ sessionId, id },
			)
}
