import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename } from 'node:path'
import {
	type DeliverRequest,
	type DeliverResponse,
	type Message,
	PEER_PROTOCOL_VERSION,
	PEER_TRAIL_MAX,
	PeerClient,
	type PeerExchange,
	type PeerFrom,
	type PeerRecord,
	type PeerSessionState,
	createPeerEndpoint,
	createRuntimeContextMessage,
	defineTool,
	derivePeerRef,
	formatPeerMessage,
	generateSessionId,
	hardenPeerRuntimeDir,
	isPeerRecordLive,
	mcpJsonSchemaToZod,
	pipePeerAddress,
	readPeerRecords,
	removePeerRecord,
	resolvePeerRuntimeDir,
	udsPeerAddress,
	writePeerRecord,
} from '@namzu/sdk'
import { sanitizeLine } from '../notifications/desktop/sanitize.js'
import { restrictToOwner } from '../providers/credential-store.js'
import { processStartedBySession, runsUnderAny } from './process-ancestry.js'

const INBOX_CAPACITY = 32
const DEDUP_CAPACITY = 256

export interface PeerMail {
	readonly id: string
	readonly owner: number
	readonly from: PeerFrom
	readonly text: string
}

export function peerMailMessage(mail: PeerMail): Message {
	return createRuntimeContextMessage(
		formatPeerMessage(mail),
		mail.from.kind === 'person' ? 'person-message' : 'peer-message',
	)
}

/** The longest a person's message is drawn on its one transcript line; the model and the log hold all of it. */
const PERSON_LABEL_MAX = 400

/**
 * The transcript line for mail. The words are the kernel's; the sender's text is data after them: for the
 * person's message it is made one safe line (no line break to start a line of its own, no control or
 * direction character), so it cannot pose as a kernel line.
 */
export function peerMailLabel(mail: PeerMail): string {
	if (mail.from.kind === 'person')
		return `Message from another terminal of this account: ${sanitizeLine(mail.text, PERSON_LABEL_MAX)}`
	return `Message from ${mail.from.name}: ${mail.text}`
}

export interface LivePeersOptions {
	/** The parent of a process, for telling a person's terminal from a tool; tests supply their own. */
	readonly parentPid?: (pid: number) => number | undefined
	/** Whether a process started with the session marker in its environment; tests supply their own. */
	readonly startedBySession?: (pid: number) => boolean
	readonly home: string
	readonly cwd: string
	readonly version: string
	readonly env?: NodeJS.ProcessEnv
	readonly mode: () => string
	readonly state: () => PeerSessionState
	/** Conversation generation, not a mutable session id read after admission. */
	readonly owner: () => number
	readonly ready: () => boolean
	readonly available: () => void
	readonly report: (text: string) => void
	/** The slot a workspaces host launched this terminal under. */
	readonly hostSlot?: string
	/** The conversation this terminal is on, once it has one. */
	readonly conversation?: () => string | undefined
	/**
	 * What the conversation is called (the name a person gave it, else the one the
	 * small model wrote). It becomes the session's display name, so two sessions in
	 * one folder tell each other apart by more than a ref.
	 */
	readonly name?: () => string | undefined
	/** The non-default account label the conversation is bound to. */
	readonly account?: () => string | undefined
	/** True while the bound account is out of allowance. */
	readonly limited?: () => boolean
	/** When the spent allowance is expected back (epoch ms), if known. */
	readonly limitedUntil?: () => number | undefined
}

/** The longest display name a record carries: it is drawn in a narrow sidebar and in a message header. */
const TITLE_MAX = 40

/** The session's display name: its conversation's name as one safe line, else the folder's. */
export function displayTitle(name: string | undefined, cwd: string): string {
	const line = name === undefined ? '' : sanitizeLine(name, TITLE_MAX)
	return line === '' ? basename(cwd) : line
}

/** The directory live-session records and sockets are kept in, hardened for the current user. */
export function resolvePeerRuntime(home: string, env: NodeJS.ProcessEnv = process.env) {
	return resolvePeerRuntimeDir({
		env,
		namzuHome: home,
		uid: process.getuid?.(),
		hardenDirectory: (path, owner) => {
			// Includes Windows current-user ACL validation; POSIX ownership is
			// checked by the SDK before the directory can be used.
			resolvePeerRuntimeDirHardening(path, owner)
		},
	})
}

/** Live-instance mailbox. Durable conversation history begins only on drain. */
export async function openLivePeers(options: LivePeersOptions) {
	const uid = process.getuid?.()
	const runtime = resolvePeerRuntime(options.home, options.env ?? process.env)
	const sessionId = generateSessionId()
	const ref = derivePeerRef(sessionId)
	const cwd = realpathSync(options.cwd)
	const address =
		process.platform === 'win32'
			? pipePeerAddress(
					createHash('sha256').update(options.home).digest('hex').slice(0, 16),
					sessionId,
				)
			: udsPeerAddress(runtime.path, sessionId)
	const token = randomBytes(32).toString('hex')
	const startedAt = Date.now()
	let enabled = true
	let closed = false
	let closing: Promise<void> | undefined
	/** The latest exchanges with other terminals, for a host that draws who is talking to whom. Who, which way, when: never text. */
	const trail: PeerExchange[] = []
	const noteExchange = (peerRef: string, dir: 'in' | 'out') => {
		trail.push({ with: peerRef, dir, at: Date.now() })
		if (trail.length > PEER_TRAIL_MAX) trail.splice(0, trail.length - PEER_TRAIL_MAX)
		publish()
	}
	const pending: PeerMail[] = []
	const accepted = new Map<string, { readonly text: string; readonly owner: number }>()
	const client = new PeerClient()
	const record = (): PeerRecord => ({
		v: 1,
		sessionId,
		ref,
		pid: process.pid,
		startedAt,
		kind: 'tui',
		title: displayTitle(options.name?.(), cwd),
		cwd,
		permissionMode: options.mode(),
		state: options.state(),
		acceptsMessages: enabled && options.ready() && !closed,
		address,
		token,
		protocol: PEER_PROTOCOL_VERSION,
		cliVersion: options.version,
		...(options.hostSlot ? { hostSlot: options.hostSlot } : {}),
		...(options.conversation?.() ? { conversationId: options.conversation() as string } : {}),
		...(options.account?.() ? { account: options.account() as string } : {}),
		...(options.limited?.() ? { limited: true } : {}),
		...(options.limited?.() && options.limitedUntil?.()
			? { limitedUntil: options.limitedUntil() as number }
			: {}),
		// Only a terminal inside a workspaces host writes it, like the other host-facing fields, so a
		// plain terminal stays readable by builds that predate it.
		...(options.hostSlot && trail.length > 0 ? { trail: [...trail] } : {}),
	})
	const from = (): PeerFrom => {
		const current = record()
		return {
			sessionId,
			ref,
			name: current.title ?? ref,
			address,
			mode: current.permissionMode,
			kind: 'tui',
		}
	}
	const publish = () => {
		if (closed) return
		discardStale()
		try {
			writePeerRecord(runtime.sessionsDir, record())
		} catch (error) {
			// Optional messaging must not terminate the operator's main turn.
			if (enabled)
				options.report(
					`Peer messaging is off because its live record could not be updated: ${String(error)}`,
				)
			enabled = false
		}
	}
	const discardStale = () => {
		const owner = options.owner()
		const mode = options.mode()
		let dropped = 0
		let modeChanged = 0
		for (let index = pending.length - 1; index >= 0; index--) {
			const mail = pending[index]
			if (!mail) continue
			if (mail.owner !== owner) {
				pending.splice(index, 1)
				dropped++
			} else if (mail.from.kind !== 'person' && mail.from.mode !== mode) {
				// Admission is not a grant to run this context under a later mode.
				// Recheck at peek AND consumption: a scheduled idle wake can outlive
				// a mode change. Discard rather than inventing approval or replay.
				pending.splice(index, 1)
				modeChanged++
			}
		}
		if (dropped)
			options.report(
				`${dropped} peer message(s) were not delivered because the conversation changed.`,
			)
		if (modeChanged)
			options.report(
				`${modeChanged} peer message(s) were not delivered because the permission mode changed.`,
			)
	}
	const receive = (request: DeliverRequest): DeliverResponse => {
		if (!request.text.trim()) return { status: 'refused', reason: 'Message must contain text.' }
		if (closed || !enabled || !options.ready())
			return {
				status: 'refused',
				reason: 'This terminal is not accepting messages.',
			}
		const sender = readPeerRecords(runtime.sessionsDir).find(
			(peer) => peer.sessionId === request.from.sessionId,
		)
		// A command-line sender (`namzu peers send`) is a verified record like a terminal's, but
		// listed apart: its mail says so, and it never takes mail.
		const person = sender?.kind === 'person'
		// The person's own message names the conversation it meant, so it is checked by what it
		// is addressed to, not by the folder: a terminal in another folder can be the right one.
		if (
			!sender ||
			(sender.kind !== 'tui' && sender.kind !== 'cli' && !person) ||
			(!person && sender.cwd !== cwd)
		)
			return {
				status: 'refused',
				reason: 'Only live terminals in the same project may send here.',
			}
		if (person) {
			// A person's message comes from outside every Namzu session. A command a model ran through its
			// shell descends from the terminal that runs it, so it is not the person, whatever it claims.
			const sessions = new Set<number>([process.pid])
			for (const peer of readPeerRecords(runtime.sessionsDir))
				if (peer.kind === 'tui') sessions.add(peer.pid)
			if (
				runsUnderAny(sender.pid, sessions, options.parentPid) ||
				(options.startedBySession ?? processStartedBySession)(sender.pid)
			)
				return {
					status: 'refused',
					reason:
						'This was sent from inside a Namzu session, by a tool or an agent, not by a person at another terminal.',
				}
			if (!request.conversation || request.conversation !== options.conversation?.())
				return {
					status: 'refused',
					reason: 'This terminal is not on that conversation now.',
				}
		}
		// The person has no permission mode to match; an agent's mail must match, so a terminal in a
		// stricter mode is not argued out of it by a sender in a looser one.
		if (!person && request.from.mode !== options.mode())
			return {
				status: 'refused',
				reason: 'The terminals have different permission modes.',
			}
		const key = `${request.from.sessionId}:${request.id}`
		const previous = accepted.get(key)
		if (previous)
			return previous.text === request.text && previous.owner === options.owner()
				? { status: 'queued', reason: 'Already accepted; not queued twice.' }
				: {
						status: 'refused',
						reason: 'This message id belongs to different content or a previous conversation.',
					}
		discardStale()
		if (pending.length >= INBOX_CAPACITY)
			return { status: 'refused', reason: 'The receiving inbox is full.' }
		const owner = options.owner()
		accepted.set(key, { text: request.text, owner })
		if (accepted.size > DEDUP_CAPACITY) accepted.delete(accepted.keys().next().value as string)
		pending.push({
			id: request.id,
			owner,
			from: request.from,
			text: request.text,
		})
		options.available()
		noteExchange(request.from.ref, 'in')
		return {
			status: 'queued',
			reason: 'Accepted in the live inbox; this is not proof of model delivery.',
		}
	}
	const endpoint = await createPeerEndpoint({
		address,
		token,
		uid,
		sessionsDir: runtime.sessionsDir,
		getState: options.state,
		onDeliver: receive,
		onSubscribeIdle: () => ({
			status: 'refused',
			reason: 'Idle subscriptions are not supported by this terminal.',
		}),
		onNotice: () => {},
	})
	try {
		writePeerRecord(runtime.sessionsDir, record())
	} catch (error) {
		await endpoint.close()
		throw error
	}
	/**
	 * A person's message is told it was taken: this process has it out of the inbox and into the turn it is
	 * running, to be recorded and sent with the next request. Said once, to the sender's own endpoint, which
	 * verifies this record before it believes it. A sender that has gone away simply hears nothing; the
	 * message is taken all the same.
	 */
	const tellTaken = (taken: readonly PeerMail[]) => {
		const people = taken.filter((mail) => mail.from.kind === 'person')
		if (people.length === 0) return
		publish()
		const current = from()
		for (const mail of people) {
			const target = readPeerRecords(runtime.sessionsDir).find(
				(peer) => peer.sessionId === mail.from.sessionId && peer.kind === 'person',
			)
			if (!target) continue
			void client
				.notice(target, {
					from: current,
					kind: 'delivery',
					about: { sessionId, name: current.name, ref },
					outcome: 'delivered',
					detail: mail.id,
				})
				.catch(() => {})
		}
	}
	const list = async () => {
		// A failed ping is an unavailable observation, not permission to delete
		// another running process's endpoint (or a replaced registry record).
		const records = readPeerRecords(runtime.sessionsDir).filter(
			(peer) => peer.cwd === cwd && peer.kind === 'tui',
		)
		const live = await Promise.all(
			records.map(async (peer) => ((await isPeerRecordLive(peer)) ? peer : undefined)),
		)
		return live
			.filter((peer): peer is PeerRecord => peer !== undefined)
			.map((peer) => ({
				session_id: peer.sessionId,
				ref: peer.ref,
				title: peer.title,
				cwd: peer.cwd,
				permission_mode: peer.permissionMode,
				state: peer.state,
				accepts_messages: peer.acceptsMessages,
				self: peer.sessionId === sessionId,
			}))
	}
	const send = async (target: string, message: string) => {
		if (closed || !enabled) return { status: 'refused', reason: 'Peer messaging is off.' }
		if (!message.trim() || Buffer.byteLength(message) > 32 * 1024)
			return {
				status: 'refused',
				reason: 'Message must contain text and fit in 32 KiB.',
			}
		publish()
		if (!enabled) return { status: 'refused', reason: 'Peer messaging is off.' }
		const candidates = readPeerRecords(runtime.sessionsDir).filter(
			(peer) =>
				peer.cwd === cwd &&
				peer.kind === 'tui' &&
				(peer.sessionId === target ||
					peer.ref === target ||
					peer.title === target ||
					peer.address === target),
		)
		if (candidates.length !== 1)
			return {
				status: 'refused',
				reason: candidates.length
					? 'Target is ambiguous; use its exact live session id.'
					: 'No matching terminal in this project. Use list_sessions.',
			}
		const peer = candidates[0]
		if (!peer) return { status: 'refused', reason: 'No matching terminal.' }
		if (peer.sessionId === sessionId)
			return {
				status: 'refused',
				reason: 'Cannot send to this same terminal.',
			}
		if (!peer.acceptsMessages)
			return {
				status: 'refused',
				reason: 'The target is not accepting messages.',
			}
		if (!(await isPeerRecordLive(peer)))
			return {
				status: 'unreachable',
				reason: 'The target did not answer. No message was sent.',
			}
		const id = generateSessionId()
		const result = await client.deliver(peer, {
			id,
			from: from(),
			text: message,
		})
		if (result.kind === 'responded' && result.status === 'queued') noteExchange(peer.ref, 'out')
		return result.kind === 'responded'
			? {
					id,
					session_id: peer.sessionId,
					status: result.status,
					reason: result.reason,
				}
			: {
					id,
					status: 'unreachable',
					reason: 'No receipt arrived; acceptance is unknown. Do not automatically retry.',
				}
	}

	return {
		id: sessionId,
		ref,
		publish,
		list,
		send,
		get enabled() {
			return enabled
		},
		get pending() {
			discardStale()
			return pending.length
		},
		setEnabled(value: boolean) {
			enabled = value
			publish()
			if (value) options.available()
		},
		peek(owner: number): readonly PeerMail[] {
			discardStale()
			return closed || !enabled || owner !== options.owner() ? [] : [...pending]
		},
		takeExact(owner: number, id: string): PeerMail | undefined {
			discardStale()
			if (closed || !enabled || owner !== options.owner()) return undefined
			const index = pending.findIndex((mail) => mail.id === id && mail.owner === owner)
			const taken = index < 0 ? undefined : pending.splice(index, 1)[0]
			if (taken) tellTaken([taken])
			return taken
		},
		take(owner: number, limit = INBOX_CAPACITY): PeerMail[] {
			discardStale()
			if (closed || !enabled || owner !== options.owner()) return []
			const taken = pending.splice(0, limit)
			tellTaken(taken)
			return taken
		},
		close(): Promise<void> {
			if (closing) return closing
			closed = true
			enabled = false
			if (pending.length)
				options.report(
					`${pending.length} peer message(s) were not delivered before this terminal closed.`,
				)
			pending.length = 0
			closing = endpoint
				.close()
				.finally(() => removePeerRecord(runtime.sessionsDir, sessionId, uid))
			return closing
		},
	}
}

// Kept outside the host factory so the SDK's checked POSIX boundary remains
// the same, while the CLI supplies its established Windows ACL protection.
function resolvePeerRuntimeDirHardening(path: string, uid: number | undefined): void {
	hardenPeerRuntimeDir(path, uid)
	restrictToOwner(path)
}

export type LivePeers = Awaited<ReturnType<typeof openLivePeers>>

export function buildPeerTools(current: () => LivePeers | null) {
	return [
		defineTool({
			name: 'list_sessions',
			description:
				'List live terminals in this project for peer messaging. These are independent processes, not child tasks or archived conversations. Tokens are never returned.',
			inputSchema: mcpJsonSchemaToZod({
				type: 'object',
				properties: {},
				additionalProperties: false,
			}),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			async execute() {
				const peers = current()
				if (!peers)
					return {
						success: false,
						output: '',
						error: 'Peer messaging is not ready.',
					}
				const sessions = await peers.list()
				return {
					success: true,
					output: JSON.stringify(sessions),
					data: { sessions },
				}
			},
		}),
		defineTool({
			name: 'send_session_message',
			description:
				'Send context to another live terminal found by list_sessions. Queued means accepted, not read or completed. Idle receivers start a turn; busy receivers read at their next safe request boundary. Does not grant approvals, interrupt, spawn, or restart a terminal. Use send_message for owned child tasks.',
			inputSchema: mcpJsonSchemaToZod({
				type: 'object',
				properties: {
					target: {
						type: 'string',
						description:
							'Exact live session id, short ref or unambiguous title from list_sessions.',
					},
					message: {
						type: 'string',
						description: 'Peer context; carries no operator authority.',
					},
				},
				required: ['target', 'message'],
				additionalProperties: false,
			}),
			category: 'custom',
			permissions: [],
			readOnly: false,
			destructive: false,
			concurrencySafe: false,
			async execute(input, context) {
				context.abortSignal.throwIfAborted()
				const peers = current()
				if (!peers)
					return {
						success: false,
						output: '',
						error: 'Peer messaging is not ready.',
					}
				const { target, message } = input as {
					target: string
					message: string
				}
				const receipt = await peers.send(target, message)
				return {
					success: receipt.status === 'queued',
					output: JSON.stringify(receipt),
					data: receipt,
				}
			},
		}),
	]
}
